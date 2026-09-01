//go:build windows

package main

import (
	"fmt"
	"os/exec"
)

func restrictPrivateFile(path string) error {
	const script = `param([string]$Path)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$acl = Get-Acl -LiteralPath $Path
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($existing) }
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Path -AclObject $acl`
	if output, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, path).CombinedOutput(); err != nil {
		return fmt.Errorf("restricting Windows key ACL: %w: %s", err, output)
	}
	return nil
}

func restrictPrivateDirectory(path string) error {
	const script = `param([string]$Path)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$acl = Get-Acl -LiteralPath $Path
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($existing) }
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Path -AclObject $acl`
	if output, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, path).CombinedOutput(); err != nil {
		return fmt.Errorf("restricting Windows directory ACL: %w: %s", err, output)
	}
	return nil
}

func syncPrivateDirectory(string) error { return nil }
