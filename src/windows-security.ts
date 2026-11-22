import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { isObjectRecord } from "./type-guards.ts";

function powershellPath(): string {
	const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || "C:\\Windows";
	if (!isAbsolute(systemRoot)) throw new Error("Windows system root must be an absolute path");
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const POWERSHELL_PATH_ENV = "PI_KNOWLEDGE_POWERSHELL_PATH";
const POWERSHELL_ACTION_ENV = "PI_KNOWLEDGE_POWERSHELL_ACTION";
const POWERSHELL_KIND_ENV = "PI_KNOWLEDGE_POWERSHELL_KIND";
const POWERSHELL_ANCESTORS_ENV = "PI_KNOWLEDGE_POWERSHELL_ANCESTORS";
const MAX_POWERSHELL_ERROR_CHARS = 2_048;

const WINDOWS_SECURITY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:PI_KNOWLEDGE_POWERSHELL_PATH
$action = $env:PI_KNOWLEDGE_POWERSHELL_ACTION
$kind = $env:PI_KNOWLEDGE_POWERSHELL_KIND
$checkAncestors = $env:PI_KNOWLEDGE_POWERSHELL_ANCESTORS -eq 'true'
if ([string]::IsNullOrWhiteSpace($p)) { throw 'Missing Windows security path' }
if ($action -notin @('ensure', 'assert', 'ancestors')) { throw 'Invalid Windows security action' }
if ($kind -notin @('directory', 'file')) { throw 'Invalid Windows security path kind' }

$ownerAccess = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$administrators = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$trustedPrivate = @($me.Value, $system.Value, $administrators.Value)
$trustedAncestors = @($me.Value, $system.Value, $administrators.Value, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$danger = [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
	[Security.AccessControl.FileSystemRights]::TakeOwnership -bor
	[Security.AccessControl.FileSystemRights]::Delete -bor
	[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles

function Get-ScopedSecurity([System.IO.FileSystemInfo]$item) {
	if ($item -is [System.IO.DirectoryInfo]) {
		return ([System.IO.DirectoryInfo]$item).GetAccessControl($ownerAccess)
	}
	return ([System.IO.FileInfo]$item).GetAccessControl($ownerAccess)
}

function Test-Private([System.IO.FileSystemInfo]$item, [bool]$requireProtected) {
	$security = Get-ScopedSecurity $item
	$owner = $security.GetOwner([Security.Principal.SecurityIdentifier]).Value
	$unsafe = 0
	foreach ($rule in @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
		if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
			$trustedPrivate -notcontains $rule.IdentityReference.Value) {
			$unsafe++
		}
	}
	return $trustedPrivate -contains $owner -and (-not $requireProtected -or $security.AreAccessRulesProtected) -and $unsafe -eq 0
}

function Set-Private([System.IO.FileSystemInfo]$item) {
	$security = if ($item -is [System.IO.DirectoryInfo]) {
		New-Object Security.AccessControl.DirectorySecurity
	} else {
		New-Object Security.AccessControl.FileSecurity
	}
	$security.SetAccessRuleProtection($true, $false)
	$security.SetOwner($me)
	$inheritance = if ($item -is [System.IO.DirectoryInfo]) {
		[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
	} else {
		[Security.AccessControl.InheritanceFlags]::None
	}
	$propagation = [Security.AccessControl.PropagationFlags]::None
	$allow = [Security.AccessControl.AccessControlType]::Allow
	foreach ($sid in @($me, $system, $administrators)) {
		$rule = [Security.AccessControl.FileSystemAccessRule]::new(
			$sid,
			[Security.AccessControl.FileSystemRights]::FullControl,
			$inheritance,
			$propagation,
			$allow
		)
		[void]$security.AddAccessRule($rule)
	}
	if ($item -is [System.IO.DirectoryInfo]) {
		([System.IO.DirectoryInfo]$item).SetAccessControl($security)
	} else {
		([System.IO.FileInfo]$item).SetAccessControl($security)
	}
}

function Test-Ancestors([System.IO.FileSystemInfo]$item) {
	$unsafe = 0
	while ($null -ne $item) {
		$security = Get-ScopedSecurity $item
		$owner = $security.GetOwner([Security.Principal.SecurityIdentifier]).Value
		if ($trustedAncestors -notcontains $owner) { $unsafe++ }
		foreach ($rule in @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
			if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
				($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
				($rule.FileSystemRights -band $danger) -ne 0 -and
				$trustedAncestors -notcontains $rule.IdentityReference.Value) {
				$unsafe++
			}
		}
		$item = if ($item -is [System.IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
	}
	return $unsafe -eq 0
}

$item = Get-Item -LiteralPath $p -Force
$isDirectory = $item -is [System.IO.DirectoryInfo]
if (($kind -eq 'directory') -ne $isDirectory) { throw 'Windows security path kind changed' }
$changed = $false
$private = $null
if ($action -ne 'ancestors') {
	$private = Test-Private $item ($action -eq 'ensure')
	if ($action -eq 'ensure' -and -not $private) {
		Set-Private $item
		$changed = $true
		$item = Get-Item -LiteralPath $p -Force
		$private = Test-Private $item $true
	}
	if (-not $private) { throw 'Windows path is not private to the current user' }
}
$ancestorsTrusted = $true
if ($checkAncestors -or $action -eq 'ancestors') {
	$ancestorsTrusted = Test-Ancestors $item
	if (-not $ancestorsTrusted) { throw 'Windows path or ancestor is controlled by an untrusted principal' }
}
[pscustomobject]@{
	private = $private
	ancestors_trusted = $ancestorsTrusted
	changed = $changed
} | ConvertTo-Json -Compress
`;

interface WindowsSecurityResult {
	private: boolean | null;
	ancestors_trusted: boolean;
	changed: boolean;
}

function powerShellErrorDetail(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("stderr" in error)) return undefined;
	const stderr = error.stderr;
	const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
	const compact = text.replace(/\s+/g, " ").trim();
	return compact ? compact.slice(0, MAX_POWERSHELL_ERROR_CHARS) : undefined;
}

function runWindowsSecurity(
	path: string,
	action: "ensure" | "assert" | "ancestors",
	directory: boolean,
	checkAncestors: boolean,
): WindowsSecurityResult {
	try {
		const output = execFileSync(
			powershellPath(),
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SECURITY_SCRIPT],
			{
				encoding: "utf8",
				env: {
					...process.env,
					[POWERSHELL_PATH_ENV]: path,
					[POWERSHELL_ACTION_ENV]: action,
					[POWERSHELL_KIND_ENV]: directory ? "directory" : "file",
					[POWERSHELL_ANCESTORS_ENV]: checkAncestors ? "true" : "false",
				},
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				windowsHide: true,
			},
		).trim();
		const parsed = JSON.parse(output) as unknown;
		if (
			!isObjectRecord(parsed) ||
			(parsed.private !== null && typeof parsed.private !== "boolean") ||
			typeof parsed.ancestors_trusted !== "boolean" ||
			typeof parsed.changed !== "boolean"
		) {
			throw new Error("Windows security command returned an invalid result");
		}
		return parsed as unknown as WindowsSecurityResult;
	} catch (error) {
		const detail = powerShellErrorDetail(error);
		throw new Error(detail ? `Windows security command failed: ${detail}` : "Windows security command failed", {
			cause: error,
		});
	}
}

export function ensureWindowsPathPrivate(path: string, directory: boolean, checkAncestors = true): void {
	if (process.platform !== "win32") return;
	runWindowsSecurity(path, "ensure", directory, checkAncestors);
}

export function assertWindowsPathPrivate(path: string, directory: boolean, checkAncestors = true): void {
	if (process.platform !== "win32") return;
	runWindowsSecurity(path, "assert", directory, checkAncestors);
}

export function assertWindowsPathAncestorsTrusted(path: string, directory: boolean): void {
	if (process.platform !== "win32") return;
	runWindowsSecurity(path, "ancestors", directory, true);
}

export function assertWindowsExecutableTrusted(path: string): void {
	if (process.platform !== "win32") return;
	runWindowsSecurity(path, "ancestors", false, true);
}
