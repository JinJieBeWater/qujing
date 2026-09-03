package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: qujing-transport serve|key-create|connect")
	}
	switch args[0] {
	case "serve":
		return serve(args[1:])
	case "key-create":
		return keyCreate(args[1:])
	case "connect":
		return connect(args[1:])
	case "key-validate":
		return keyValidate()
	default:
		return fmt.Errorf("unknown command: %s", args[0])
	}
}

func keyValidate() error {
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
	if err != nil {
		return err
	}
	if len(data) > 4096 {
		return errors.New("public key is too large")
	}
	if err := validatePublicKey(string(data)); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": true})
}

func validatePublicKey(text string) error {
	var public key.NodePublic
	if err := public.UnmarshalText([]byte(strings.TrimSpace(text))); err != nil || public.IsZero() {
		return errors.New("invalid Tailcat public key")
	}
	return nil
}

type repeatedStrings []string

func (values *repeatedStrings) String() string { return fmt.Sprint([]string(*values)) }
func (values *repeatedStrings) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	keyPath := flags.String("key", "", "server key path")
	port := flags.Int("port", 0, "only local TCP port to serve")
	var allowed repeatedStrings
	flags.Var(&allowed, "allow", "allowed client public key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *keyPath == "" || *port < 1 || *port > 65535 || len(allowed) == 0 {
		return errors.New("serve requires --key, valid --port, and at least one --allow")
	}
	privateKey, err := loadOrCreateServerKey(*keyPath)
	if err != nil {
		return fmt.Errorf("server key: %w", err)
	}
	server := &tailcat.Server{
		Key:    privateKey.Private,
		Region: privateKey.Public.Region[0],
		Logf:   discardLog,
	}
	for _, text := range allowed {
		var public key.NodePublic
		if text != "none" {
			if err := public.UnmarshalText([]byte(text)); err != nil {
				return fmt.Errorf("invalid allowed client key: %w", err)
			}
		}
		server.AddAllowedClient(public)
	}
	server.OnTCP = func(requested uint16) func(net.Conn) {
		if requested != uint16(*port) {
			return nil
		}
		return func(remote net.Conn) {
			local, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
			if err != nil {
				remote.Close()
				return
			}
			tailcat.ProxyConns(remote, local)
		}
	}
	if err := server.Start(); err != nil {
		return fmt.Errorf("Tailcat bootstrap failed: %w", err)
	}
	defer server.Close()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
		"ready": true, "serverAddress": server.ConnBlob(), "remotePort": *port,
	}); err != nil {
		return err
	}
	waitForSignal()
	return nil
}

func keyCreate(args []string) error {
	flags := flag.NewFlagSet("key-create", flag.ContinueOnError)
	output := flags.String("output", "", "client key path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *output == "" {
		return errors.New("key-create requires --output")
	}
	privateKey := tailcat.NewPrivateKey()
	if err := writeNewPrivateJSON(*output, privateKey); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"ready": true, "publicKey": privateKey.Private.Public().String(), "keyPath": *output,
	})
}

func connect(args []string) error {
	flags := flag.NewFlagSet("connect", flag.ContinueOnError)
	serverAddress := flags.String("server", "", "Tailcat server address")
	port := flags.Int("port", 0, "remote port")
	keyPath := flags.String("key", "", "client key path")
	listenAddress := flags.String("listen", "", "loopback listen address")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *serverAddress == "" || *keyPath == "" || *port < 1 || *port > 65535 {
		return errors.New("connect requires --server, --key, and valid --port")
	}
	if err := requireLoopback(*listenAddress); err != nil {
		return err
	}
	privateKey, err := readPrivateKey(*keyPath)
	if err != nil {
		return fmt.Errorf("client key: %w", err)
	}
	clients := &clientManager{server: tailcat.ConnBlob(*serverAddress), privateKey: privateKey.Private}
	defer clients.close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	readyCtx, readyCancel := context.WithTimeout(ctx, 35*time.Second)
	defer readyCancel()
	if err := clients.prepare(readyCtx); err != nil {
		return fmt.Errorf("Tailcat connection failed: %w", err)
	}
	transportDebugf("Tailcat connection ready")
	listener, err := net.Listen("tcp", *listenAddress)
	if err != nil {
		return fmt.Errorf("loopback listener: %w", err)
	}
	defer listener.Close()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
		"ready": true, "localAddress": listener.Addr().String(),
	}); err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		listener.Close()
	}()
	for {
		local, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		transportDebugf("accepted local connection")
		go bridge(clients, local, uint16(*port))
	}
}

func (manager *clientManager) prepare(ctx context.Context) error {
	for {
		client := &tailcat.Client{Server: manager.server, Key: manager.privateKey, Logf: discardLog}
		attemptCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		_, err := client.Ping(attemptCtx)
		cancel()
		if err == nil {
			manager.mu.Lock()
			if manager.client == nil {
				manager.client = client
				manager.mu.Unlock()
				return nil
			}
			manager.mu.Unlock()
			client.Close()
			return nil
		}
		client.Close()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

type clientManager struct {
	mu         sync.Mutex
	setupMu    sync.Mutex
	server     tailcat.ConnBlob
	privateKey key.NodePrivate
	client     *tailcat.Client
	active     int
	idleTimer  *time.Timer
	idleDelay  time.Duration
	pingClient func(context.Context, *tailcat.Client) error
}

func (manager *clientManager) acquire() (*tailcat.Client, func()) {
	manager.mu.Lock()
	if manager.idleTimer != nil {
		manager.idleTimer.Stop()
		manager.idleTimer = nil
	}
	if manager.client == nil {
		manager.client = &tailcat.Client{Server: manager.server, Key: manager.privateKey, Logf: discardLog}
	}
	client := manager.client
	manager.active++
	manager.mu.Unlock()
	return client, func() {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		manager.active--
		if manager.active == 0 && manager.client == client {
			delay := manager.idleDelay
			if delay == 0 {
				delay = time.Second
			}
			manager.idleTimer = time.AfterFunc(delay, func() {
				manager.mu.Lock()
				defer manager.mu.Unlock()
				if manager.active == 0 && manager.client == client {
					client.Close()
					manager.client = nil
				}
				manager.idleTimer = nil
			})
		}
	}
}

func (manager *clientManager) close() {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.idleTimer != nil {
		manager.idleTimer.Stop()
		manager.idleTimer = nil
	}
	if manager.client != nil {
		manager.client.Close()
		manager.client = nil
	}
}

func (manager *clientManager) ensureReady(ctx context.Context, client *tailcat.Client) error {
	manager.setupMu.Lock()
	defer manager.setupMu.Unlock()
	if err := manager.ping(ctx, client); err != nil {
		return err
	}
	return nil
}

func (manager *clientManager) ping(ctx context.Context, client *tailcat.Client) error {
	if manager.pingClient != nil {
		return manager.pingClient(ctx, client)
	}
	_, err := client.Ping(ctx)
	return err
}

func bridge(manager *clientManager, local net.Conn, port uint16) {
	defer local.Close()
	client, release := manager.acquire()
	defer release()
	transportDebugf("starting bridge")
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	remote, err := bootstrap(ctx,
		func(ctx context.Context) error { return manager.ensureReady(ctx, client) },
		func(ctx context.Context) (net.Conn, error) { return client.DialTCPPort(ctx, port) },
	)
	if err != nil {
		transportDebugf("bridge bootstrap failed: %v", err)
		return
	}
	transportDebugf("bridge connected")
	tailcat.ProxyConns(local, remote)
	transportDebugf("bridge closed")
}

func transportDebugf(format string, args ...any) {
	if os.Getenv("QUJING_TRANSPORT_DEBUG") == "1" {
		fmt.Fprintf(os.Stderr, "transport: "+format+"\n", args...)
	}
}

func bootstrap(ctx context.Context, ping func(context.Context) error, dial func(context.Context) (net.Conn, error)) (net.Conn, error) {
	for {
		if err := ping(ctx); err == nil {
			if remote, err := dial(ctx); err == nil {
				return remote, nil
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func requireLoopback(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid --listen: %w", err)
	}
	if host != "127.0.0.1" {
		return errors.New("connector must listen on 127.0.0.1")
	}
	return nil
}

func loadOrCreateServerKey(path string) (*tailcat.PrivateKey, error) {
	privateKey, err := readPrivateKey(path)
	if errors.Is(err, os.ErrNotExist) {
		privateKey = tailcat.NewPrivateKey()
		privateKey.Public.RegionID = -1
	} else if err != nil {
		return nil, err
	}
	if len(privateKey.Public.Region) == 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := privateKey.Public.Expand(ctx, tailcat.ExpandForServer); err != nil {
			return nil, err
		}
		if err := writePrivateJSON(path, privateKey); err != nil {
			return nil, err
		}
	}
	return privateKey, nil
}

func readPrivateKey(path string) (*tailcat.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var privateKey tailcat.PrivateKey
	if err := json.Unmarshal(data, &privateKey); err != nil {
		return nil, err
	}
	if privateKey.Private.IsZero() {
		return nil, errors.New("private key is empty")
	}
	return &privateKey, nil
}

func writePrivateJSON(path string, value any) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return err
	}
	if err := restrictPrivateDirectory(directory); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".key-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0600); err != nil {
		temporary.Close()
		return err
	}
	if err := json.NewEncoder(temporary).Encode(value); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	if err := os.Chmod(path, 0600); err != nil {
		return err
	}
	if err := restrictPrivateFile(path); err != nil {
		return err
	}
	return syncPrivateDirectory(directory)
}

func writeNewPrivateJSON(path string, value any) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	staged, err := os.CreateTemp(directory, ".key-new-*")
	if err != nil {
		return err
	}
	stagedPath := staged.Name()
	if err := staged.Close(); err != nil {
		os.Remove(stagedPath)
		return err
	}
	if err := os.Remove(stagedPath); err != nil {
		return err
	}
	defer os.Remove(stagedPath)
	if err := writePrivateJSON(stagedPath, value); err != nil {
		return err
	}
	if err := os.Link(stagedPath, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("key already exists: %s: %w", path, err)
		}
		return err
	}
	return syncPrivateDirectory(directory)
}

func waitForSignal() {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
}

func discardLog(string, ...any) {}
