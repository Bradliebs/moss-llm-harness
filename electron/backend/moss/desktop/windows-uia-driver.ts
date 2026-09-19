import { spawn } from "node:child_process";

import type {
  DesktopControlSelector,
  DesktopControlState,
  DesktopDriver,
  DesktopDriverFactory,
  DesktopDriverScope,
} from "./desktop-tools";

const BRIDGE_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 50_000;

interface BridgeRequest {
  action: "inspect" | "invoke" | "type" | "select" | "screenshot" | "state";
  processName: string;
  windowTitle: string;
  selector?: DesktopControlSelector;
  text?: string;
  clear?: boolean;
  option?: string;
  path?: string;
}

export function createWindowsUiaDriverFactory(): DesktopDriverFactory {
  return async (scope) => new WindowsUiaDriver(scope);
}

class WindowsUiaDriver implements DesktopDriver {
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<string>>();
  constructor(private readonly scope: DesktopDriverScope) {}

  inspect(): Promise<string> {
    return this.execute({ action: "inspect" });
  }

  async invoke(target: DesktopControlSelector): Promise<void> {
    await this.execute({ action: "invoke", selector: target });
  }

  async type(target: DesktopControlSelector, text: string, clear: boolean): Promise<void> {
    await this.execute({ action: "type", selector: target, text, clear });
  }

  async select(target: DesktopControlSelector, option: string): Promise<void> {
    await this.execute({ action: "select", selector: target, option });
  }

  async screenshot(path: string): Promise<void> {
    await this.execute({ action: "screenshot", path });
  }

  async controlState(target: DesktopControlSelector): Promise<DesktopControlState> {
    return JSON.parse(await this.execute({ action: "state", selector: target })) as DesktopControlState;
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.active]);
  }

  private async execute(request: Omit<BridgeRequest, "processName" | "windowTitle">): Promise<string> {
    const pending = runBridge({ ...request, processName: this.scope.processName, windowTitle: this.scope.windowTitle }, this.controller.signal);
    this.active.add(pending);
    try { return await pending; }
    finally { this.active.delete(pending); }
  }
}

function runBridge(request: BridgeRequest, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error("Desktop session closed"));
  if (process.platform !== "win32") return Promise.reject(new Error("Windows UI Automation requires Windows"));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_UIA_BRIDGE],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    let settled = false;
    let stopped: Error | undefined;
    const finish = (failure?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else resolve(output.trim());
    };
    const stop = (message: string) => {
      if (settled || stopped) return;
      stopped = new Error(message);
      clearTimeout(timer);
      child.kill();
      timer = setTimeout(() => finish(new Error(`${message}; bridge termination unconfirmed`)), 5_000);
    };
    let timer = setTimeout(() => stop("Windows UI Automation operation timed out"), BRIDGE_TIMEOUT_MS);
    const onAbort = () => {
      stop("Windows UI Automation operation aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < OUTPUT_CAP) output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (error.length < OUTPUT_CAP) error += chunk.toString();
    });
    child.on("error", (spawnError) => finish(spawnError));
    child.on("close", (code) => {
      if (stopped) finish(stopped);
      else if (code === 0) finish();
      else finish(new Error(error.trim() || output.trim() || `Windows UI Automation exited with code ${code}`));
    });
    child.stdin.end(JSON.stringify(request));
    if (signal.aborted) onAbort();
  });
}

const WINDOWS_UIA_BRIDGE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$request = ($input | Out-String | ConvertFrom-Json)
$processName = [System.IO.Path]::GetFileNameWithoutExtension([string]$request.processName)
$process = Get-Process -Name $processName -ErrorAction Stop | Where-Object { $_.MainWindowTitle -eq [string]$request.windowTitle } | Select-Object -First 1
if (-not $process -or $process.MainWindowHandle -eq 0) { throw 'Allow-listed process/window is not available' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
function Get-ControlType($name) {
  switch ([string]$name) {
    'Button' { return [System.Windows.Automation.ControlType]::Button }
    'CheckBox' { return [System.Windows.Automation.ControlType]::CheckBox }
    'ComboBox' { return [System.Windows.Automation.ControlType]::ComboBox }
    'Edit' { return [System.Windows.Automation.ControlType]::Edit }
    'List' { return [System.Windows.Automation.ControlType]::List }
    'ListItem' { return [System.Windows.Automation.ControlType]::ListItem }
    'MenuItem' { return [System.Windows.Automation.ControlType]::MenuItem }
    'RadioButton' { return [System.Windows.Automation.ControlType]::RadioButton }
    'Tab' { return [System.Windows.Automation.ControlType]::Tab }
    'TabItem' { return [System.Windows.Automation.ControlType]::TabItem }
    'Text' { return [System.Windows.Automation.ControlType]::Text }
    'Window' { return [System.Windows.Automation.ControlType]::Window }
    default { throw "Unknown control type: $name" }
  }
}
function Find-Control($selector) {
  $conditions = [System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
  if ($selector.automationId) { $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$selector.automationId)) }
  if ($selector.name) { $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, [string]$selector.name)) }
  if ($selector.controlType) {
    $type = Get-ControlType $selector.controlType
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type))
  }
  if ($conditions.Count -eq 0) { throw 'A semantic selector is required' }
  $condition = if ($conditions.Count -eq 1) { $conditions[0] } else { [System.Windows.Automation.AndCondition]::new($conditions.ToArray()) }
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if (-not $element) { throw 'Semantic control was not found' }
  return $element
}
switch ([string]$request.action) {
  'inspect' {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = [System.Collections.Generic.Queue[object]]::new(); $queue.Enqueue(@($root, 0)); $lines = [System.Collections.Generic.List[string]]::new()
    while ($queue.Count -gt 0 -and $lines.Count -lt 500) {
      $item = $queue.Dequeue(); $element = $item[0]; $depth = [int]$item[1]
      $lines.Add(('  ' * $depth) + "[$($element.Current.ControlType.ProgrammaticName)] name='$($element.Current.Name)' automationId='$($element.Current.AutomationId)' enabled=$($element.Current.IsEnabled)")
      $childElement = $walker.GetFirstChild($element)
      while ($childElement) { $queue.Enqueue(@($childElement, $depth + 1)); $childElement = $walker.GetNextSibling($childElement) }
    }
    $lines -join [Environment]::NewLine
  }
  'invoke' {
    $element = Find-Control $request.selector
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke(); 'invoked'
  }
  'type' {
    $element = Find-Control $request.selector
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $pattern.SetValue([string]$request.text) }
    else { throw 'Control does not support semantic ValuePattern input' }
    'typed'
  }
  'select' {
    $element = Find-Control $request.selector
    $optionCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, [string]$request.option)
    $option = $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $optionCondition)
    if (-not $option) { throw 'Requested option was not found' }
    $pattern = $option.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $pattern.Select(); 'selected'
  }
  'state' {
    $element = Find-Control $request.selector
    $state = @{ exists = $true; enabled = $element.Current.IsEnabled }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { $state.value = $valuePattern.Current.Value }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) { $state.selected = $selectionPattern.Current.IsSelected }
    $state | ConvertTo-Json -Compress
  }
  'screenshot' {
    $bounds = $root.Current.BoundingRectangle
    $bitmap = [System.Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size); $bitmap.Save([string]$request.path, [System.Drawing.Imaging.ImageFormat]::Png) }
    finally { $graphics.Dispose(); $bitmap.Dispose() }
    'captured'
  }
  default { throw 'Unknown Windows UI Automation action' }
}`;