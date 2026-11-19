import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { isObjectRecord } from "./type-guards.ts";

function powershellPath(): string {
	const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || "C:\\Windows";
	if (!isAbsolute(systemRoot)) throw new Error("Windows system root must be an absolute path");
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShell(script: string, path: string): string {
	return execFileSync(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, path], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 10_000,
		windowsHide: true,
	}).trim();
}

export function hardenWindowsPath(path: string, directory: boolean): void {
	if (process.platform !== "win32") return;
	const inheritance = directory ? "ContainerInherit, ObjectInherit" : "None";
	runPowerShell(
		`$ErrorActionPreference='Stop'; $p=$args[0]; $me=[Security.Principal.WindowsIdentity]::GetCurrent(); $acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}; $acl.SetOwner($me.User); $inherit=[Security.AccessControl.InheritanceFlags]'${inheritance}'; $prop=[Security.AccessControl.PropagationFlags]::None; $allow=[Security.AccessControl.AccessControlType]::Allow; foreach($sid in @($me.User,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){ $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,$allow); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl`,
		path,
	);
}

export function assertWindowsPathPrivate(path: string): void {
	if (process.platform !== "win32") return;
	const output = runPowerShell(
		`$ErrorActionPreference='Stop'; $p=$args[0]; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $trusted=@($me,'S-1-5-18','S-1-5-32-544'); $acl=Get-Acl -LiteralPath $p; $owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value; $unsafe=0; foreach($rule in @($acl.Access)){ if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow){ $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($trusted -notcontains $sid){$unsafe++} } }; [pscustomobject]@{owner=$owner;current=$me;unsafe=$unsafe}|ConvertTo-Json -Compress`,
		path,
	);
	const parsed = JSON.parse(output) as unknown;
	if (
		!isObjectRecord(parsed) ||
		parsed.owner !== parsed.current ||
		typeof parsed.unsafe !== "number" ||
		parsed.unsafe !== 0
	) {
		throw new Error(`Windows path is not private to the current user: ${path}`);
	}
}

export function assertWindowsPathAncestorsTrusted(path: string): void {
	if (process.platform !== "win32") return;
	const output = runPowerShell(
		`$ErrorActionPreference='Stop'; $p=$args[0]; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $trusted=@($me,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'); $danger=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::FullControl -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories; $unsafe=0; $item=Get-Item -LiteralPath $p -Force; while($null -ne $item){ $acl=Get-Acl -LiteralPath $item.FullName; $owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value; if($trusted -notcontains $owner){$unsafe++}; foreach($rule in @($acl.Access)){ if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and (($rule.FileSystemRights -band $danger) -ne 0)){ $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($trusted -notcontains $sid){$unsafe++} } }; if($item.PSIsContainer){$item=$item.Parent}else{$item=$item.Directory} }; [pscustomobject]@{unsafe=$unsafe}|ConvertTo-Json -Compress`,
		path,
	);
	const parsed = JSON.parse(output) as unknown;
	if (!isObjectRecord(parsed) || typeof parsed.unsafe !== "number" || parsed.unsafe !== 0) {
		throw new Error(`Windows path or ancestor is controlled by an untrusted principal: ${path}`);
	}
}

export function assertWindowsExecutableTrusted(path: string): void {
	assertWindowsPathAncestorsTrusted(path);
}
