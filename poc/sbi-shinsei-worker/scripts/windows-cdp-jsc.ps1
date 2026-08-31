param(
  [string]$CdpBaseUrl = "http://127.0.0.1:9222",
  [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$ExpectedOrigin = "https://bk.web.sbishinseibank.co.jp"

function Receive-CdpMessage {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [System.Threading.CancellationToken]$CancellationToken
  )

  $Buffer = New-Object byte[] 8192
  $Stream = New-Object System.IO.MemoryStream
  do {
    $Segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$Buffer)
    $Result = $Socket.ReceiveAsync($Segment, $CancellationToken).GetAwaiter().GetResult()
    if ($Result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
      throw "Chrome CDP websocket closed before returning a result"
    }
    $null = $Stream.Write($Buffer, 0, $Result.Count)
    if ($Stream.Length -gt 65536) {
      throw "Chrome CDP response exceeded the handoff limit"
    }
  } while (-not $Result.EndOfMessage)
  return [System.Text.Encoding]::UTF8.GetString($Stream.ToArray())
}

function Invoke-JscEvaluation {
  param(
    [string]$WebSocketUrl,
    [int]$TimeoutSeconds
  )

  $Socket = New-Object System.Net.WebSockets.ClientWebSocket
  $Cancellation = New-Object System.Threading.CancellationTokenSource
  $Cancellation.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
  try {
    $null = $Socket.ConnectAsync(
      [Uri]$WebSocketUrl,
      $Cancellation.Token
    ).GetAwaiter().GetResult()
    $Expression = @'
(async () => {
  const expectedOrigin = "https://bk.web.sbishinseibank.co.jp";
  if (location.origin !== expectedOrigin) {
    return { ok: false, reason: "unexpected-origin" };
  }
  const input = document.getElementById("dtokeninfo");
  if (!(input instanceof HTMLInputElement)) {
    return { ok: false, reason: "missing-input" };
  }
  const existing = input.value;
  if (typeof existing === "string" && existing.length >= 64) {
    return { ok: true, origin: location.origin, userAgent: navigator.userAgent, jsc: existing };
  }
  const collector = globalThis.CAFISBrainRiskCollector;
  if (!collector || typeof collector.getDeviceTokenInfoV3 !== "function") {
    return { ok: false, reason: "collector-unavailable" };
  }
  const token = await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error("CAFIS callback timed out"));
    }, 30000);
    const finish = (candidate) => {
      const possibilities = [
        candidate,
        candidate && candidate.dtokeninfo,
        candidate && candidate.deviceTokenInfo,
        input.value,
      ];
      const value = possibilities.find(
        (item) => typeof item === "string" && item.length >= 64,
      );
      if (!value || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    try {
      const returned = collector.getDeviceTokenInfoV3(finish);
      if (returned && typeof returned.then === "function") {
        returned.then(finish, reject);
      } else {
        finish(returned);
      }
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
  return {
    ok: true,
    origin: location.origin,
    userAgent: navigator.userAgent,
    jsc: token,
  };
})()
'@
    $Request = @{
      id = 1
      method = "Runtime.evaluate"
      params = @{
        expression = $Expression
        awaitPromise = $true
        returnByValue = $true
      }
    } | ConvertTo-Json -Depth 8 -Compress
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Request)
    $Segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$Bytes)
    $null = $Socket.SendAsync(
      $Segment,
      [System.Net.WebSockets.WebSocketMessageType]::Text,
      $true,
      $Cancellation.Token
    ).GetAwaiter().GetResult()

    while ($true) {
      $Message = Receive-CdpMessage -Socket $Socket -CancellationToken $Cancellation.Token
      $Parsed = $Message | ConvertFrom-Json
      if ($Parsed.id -ne 1) { continue }
      if ($null -ne $Parsed.error -or $null -ne $Parsed.result.exceptionDetails) {
        return $null
      }
      return $Parsed.result.result.value
    }
  } finally {
    if ($Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $null = $Socket.CloseAsync(
        [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
        "done",
        [System.Threading.CancellationToken]::None
      ).GetAwaiter().GetResult()
    }
    $null = $Socket.Dispose()
    $null = $Cancellation.Dispose()
  }
}

$Targets = Invoke-RestMethod -Uri "$CdpBaseUrl/json/list" -Method Get -TimeoutSec 5
$Candidates = @($Targets | Where-Object {
  $_.type -eq "page" -and
  $_.url -like "$ExpectedOrigin/*" -and
  $_.webSocketDebuggerUrl
})

foreach ($Target in $Candidates) {
  $Result = Invoke-JscEvaluation `
    -WebSocketUrl $Target.webSocketDebuggerUrl `
    -TimeoutSeconds $TimeoutSeconds
  if (
    $null -ne $Result -and
    $Result.ok -eq $true -and
    $Result.origin -eq $ExpectedOrigin -and
    $Result.jsc -is [string] -and
    $Result.userAgent -is [string]
  ) {
    $Output = @{
      sourceOrigin = $ExpectedOrigin
      userAgent = $Result.userAgent
      jsc = $Result.jsc
    } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($Output)
    exit 0
  }
}

throw "No SBI Shinsei login tab returned fresh CAFIS material"
