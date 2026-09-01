//go:build !windows

package main

import "os"

func restrictPrivateFile(string) error      { return nil }
func restrictPrivateDirectory(string) error { return nil }

func syncPrivateDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
