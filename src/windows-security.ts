import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { isObjectRecord } from "./type-guards.ts";

function powershellPath(): string {
	const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || "C:\\Windows";
	if (!isAbsolute(systemRoot)) throw new Error("Windows system root must be an absolute path");
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const POWERSHELL_PATH_ENV = "PI_KNOWLEDGE_POWERSHELL_PATH";
const MAX_POWERSHELL_ERROR_CHARS = 2_048;

function powerShellErrorDetail(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("stderr" in error)) return undefined;
	const stderr = error.stderr;
	const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
	const compact = text.replace(/\s+/g, " ").trim();
	return compact ? compact.slice(0, MAX_POWERSHELL_ERROR_CHARS) : undefined;
}

function runPowerShell(script: string, path: string): string {
	const command = `$ErrorActionPreference='Stop'; $p=$env:${POWERSHELL_PATH_ENV}; if([string]::IsNullOrWhiteSpace($p)){throw 'Missing Windows security path'}; ${script}`;
	try {
		return execFileSync(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
			encoding: "utf8",
			env: { ...process.env, [POWERSHELL_PATH_ENV]: path },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			windowsHide: true,
		}).trim();
	} catch (error) {
		const detail = powerShellErrorDetail(error);
		throw new Error(detail ? `Windows security command failed: ${detail}` : "Windows security command failed", {
			cause: error,
		});
	}
}

export function hardenWindowsPath(path: string, directory: boolean): void {
	if (process.platform !== "win32") return;
	const inheritance = directory ? "ContainerInherit, ObjectInherit" : "None";
	runPowerShell(
		`$me=[Security.Principal.WindowsIdentity]::GetCurrent(); $acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}; $acl.SetOwner($me.User); $inherit=[Security.AccessControl.InheritanceFlags]'${inheritance}'; $prop=[Security.AccessControl.PropagationFlags]::None; $allow=[Security.AccessControl.AccessControlType]::Allow; foreach($sid in @($me.User,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){ $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,$allow); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl`,
		path,
	);
}

export function assertWindowsPathPrivate(path: string): void {
	if (process.platform !== "win32") return;
	const output = runPowerShell(
		`$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $trusted=@($me,'S-1-5-18','S-1-5-32-544'); $acl=Get-Acl -LiteralPath $p; $owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value; $unsafe=0; foreach($rule in @($acl.Access)){ if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow){ $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($trusted -notcontains $sid){$unsafe++} } }; [pscustomobject]@{owner=$owner;current=$me;unsafe=$unsafe}|ConvertTo-Json -Compress`,
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
		`$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $trusted=@($me,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'); $danger=[Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles; $unsafe=0; $item=Get-Item -LiteralPath $p -Force; while($null -ne $item){ $acl=Get-Acl -LiteralPath $item.FullName; $owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value; if($trusted -notcontains $owner){$unsafe++}; foreach($rule in @($acl.Access)){ if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and (($rule.FileSystemRights -band $danger) -ne 0)){ $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($trusted -notcontains $sid){$unsafe++} } }; if($item.PSIsContainer){$item=$item.Parent}else{$item=$item.Directory} }; [pscustomobject]@{unsafe=$unsafe}|ConvertTo-Json -Compress`,
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
