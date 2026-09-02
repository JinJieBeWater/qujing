package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tailscale/tailcat"
)

func TestKeyCreate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys", "client.json")
	if err := keyCreate([]string{"--output", path}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("key mode = %o; want 600", info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var privateKey tailcat.PrivateKey
	if err := json.Unmarshal(data, &privateKey); err != nil || privateKey.Private.IsZero() {
		t.Fatalf("invalid private key: %v", err)
	}
	if err := keyCreate([]string{"--output", path}); err == nil {
		t.Fatal("duplicate key creation succeeded")
	}
}

func TestWriteNewPrivateJSONDoesNotOverwriteConcurrently(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, value := range []string{"first", "second"} {
		go func() {
			<-start
			results <- writeNewPrivateJSON(path, map[string]string{"value": value})
		}()
	}
	close(start)
	succeeded := 0
	for range 2 {
		if err := <-results; err == nil {
			succeeded++
		} else if !errors.Is(err, os.ErrExist) {
			t.Fatal(err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("successful writes = %d; want 1", succeeded)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]string
	if err := json.Unmarshal(data, &stored); err != nil || (stored["value"] != "first" && stored["value"] != "second") {
		t.Fatalf("invalid stored value: %q (%v)", data, err)
	}
}

func TestRequireLoopback(t *testing.T) {
	if err := requireLoopback("127.0.0.1:43111"); err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{"0.0.0.0:43111", "[::1]:43111", "localhost:43111"} {
		if err := requireLoopback(address); err == nil {
			t.Fatalf("accepted %q", address)
		}
	}
}

func TestValidatePublicKey(t *testing.T) {
	public := tailcat.NewPrivateKey().Private.Public().String()
	if err := validatePublicKey(public); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", "none", "not-a-key"} {
		if err := validatePublicKey(value); err == nil {
			t.Fatalf("accepted invalid key %q", value)
		}
	}
}

func TestWritePrivateJSONReplacesFilePrivately(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "server-key.json")
	if err := writePrivateJSON(path, map[string]string{"value": "first"}); err != nil {
		t.Fatal(err)
	}
	if err := writePrivateJSON(path, map[string]string{"value": "second"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "second") {
		t.Fatalf("unexpected data: %s", data)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("mode = %o", info.Mode().Perm())
		}
	}
}

func TestBootstrapRetriesBeforeReadingLocalRequest(t *testing.T) {
	pingCount := 0
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	connection, err := bootstrap(context.Background(), func(context.Context) error {
		pingCount++
		if pingCount == 1 {
			return context.DeadlineExceeded
		}
		return nil
	}, func(context.Context) (net.Conn, error) { return left, nil })
	if err != nil {
		t.Fatal(err)
	}
	if pingCount != 2 || connection != left {
		t.Fatalf("ping count = %d, connection = %v", pingCount, connection)
	}
}

func TestClientManagerSharesConcurrentBridgesAndResetsAfterIdle(t *testing.T) {
	manager := &clientManager{server: "tc-invalid", privateKey: tailcat.NewPrivateKey().Private, idleDelay: 20 * time.Millisecond}
	defer manager.close()
	first, releaseFirst := manager.acquire()
	second, releaseSecond := manager.acquire()
	if first != second {
		t.Fatal("concurrent bridges did not share one Tailcat Client")
	}
	releaseFirst()
	if manager.client == nil {
		t.Fatal("client reset while another bridge was active")
	}
	releaseSecond()
	third, releaseThird := manager.acquire()
	if third != first {
		t.Fatal("sequential bridge did not reuse the client during the idle grace period")
	}
	releaseThird()
	time.Sleep(50 * time.Millisecond)
	if manager.client != nil {
		t.Fatal("client was not reset after the idle grace period")
	}
	fourth, releaseFourth := manager.acquire()
	defer releaseFourth()
	if fourth == first {
		t.Fatal("next bridge batch reused stale Tailcat Client")
	}
}

func TestClientManagerPingsEveryReusedBridge(t *testing.T) {
	pingCount := 0
	manager := &clientManager{
		server:     "tc-invalid",
		privateKey: tailcat.NewPrivateKey().Private,
		idleDelay:  time.Second,
		pingClient: func(context.Context, *tailcat.Client) error {
			pingCount++
			return nil
		},
	}
	defer manager.close()
	first, releaseFirst := manager.acquire()
	if err := manager.ensureReady(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	releaseFirst()
	second, releaseSecond := manager.acquire()
	defer releaseSecond()
	if first != second {
		t.Fatal("bridge did not reuse the client during the idle grace period")
	}
	if err := manager.ensureReady(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	if pingCount != 2 {
		t.Fatalf("Ping count = %d, want 2", pingCount)
	}
}
