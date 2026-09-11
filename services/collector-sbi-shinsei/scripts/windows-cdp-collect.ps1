param(
  [string]$CdpBaseUrl = "http://127.0.0.1:9222",
  [int]$TimeoutSeconds = 75
)

$ErrorActionPreference = "Stop"
$ExpectedOrigin = "https://bk.web.sbishinseibank.co.jp"
$MaximumMessageBytes = 12 * 1024 * 1024

function Receive-CdpMessage {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [System.Threading.CancellationToken]$CancellationToken
  )
  $Buffer = New-Object byte[] 32768
  $Stream = New-Object System.IO.MemoryStream
  do {
    $Segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$Buffer)
    $Result = $Socket.ReceiveAsync($Segment, $CancellationToken).GetAwaiter().GetResult()
    if ($Result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
      throw "Chrome CDP websocket closed before returning a result"
    }
    $null = $Stream.Write($Buffer, 0, $Result.Count)
    if ($Stream.Length -gt $MaximumMessageBytes) {
      throw "Chrome CDP response exceeded the collection limit"
    }
  } while (-not $Result.EndOfMessage)
  return [System.Text.Encoding]::UTF8.GetString($Stream.ToArray())
}

function Invoke-CollectionEvaluation {
  param(
    [string]$WebSocketUrl,
    [string]$CredentialBase64,
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
    $ExpressionTemplate = @'
(async () => {
  const expectedOrigin = "https://bk.web.sbishinseibank.co.jp";
  const maximumBytes = 2 * 1024 * 1024;
  const hasExactKeys = (value, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]);
  };
  const fail = (stage, authenticationAttempted = false) => ({
    ok: false,
    stage,
    authenticationAttempted,
  });
  if (location.origin !== expectedOrigin) return fail("unexpected-origin");
  const input = document.getElementById("dtokeninfo");
  if (!(input instanceof HTMLInputElement)) return fail("missing-input");
  const collector = globalThis.CAFISBrainRiskCollector;
  if (!collector || typeof collector.getDeviceTokenInfoV3 !== "function") {
    return fail("collector-unavailable");
  }
  input.value = "";
  let jsc;
  try {
    jsc = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("cafis-timeout")), 30000);
      collector.getDeviceTokenInfoV3((result) => {
        clearTimeout(timeout);
        const value = result && result.deviceTokenInfo;
        if (typeof value !== "string" || value.length < 64) {
          reject(new Error("cafis-result"));
          return;
        }
        input.value = value;
        resolve(value);
      });
    });
  } catch {
    input.value = "";
    return fail("cafis-generation");
  }

  let credential;
  try {
    const binary = atob("__CREDENTIAL_BASE64__");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    credential = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail("credential-decode");
  }
  if (
    !credential ||
    typeof credential.branchNumber !== "string" ||
    !/^\d{3}$/.test(credential.branchNumber) ||
    typeof credential.accountNumber !== "string" ||
    !/^\d{7}$/.test(credential.accountNumber) ||
    typeof credential.powerDirectPassword !== "string" ||
    credential.powerDirectPassword.length === 0
  ) {
    return fail("credential-shape");
  }

  const fetchText = async (path, init, stage, authenticationAttempted) => {
    let response;
    try {
      response = await fetch(path, {
        credentials: "include",
        cache: "no-store",
        redirect: "manual",
        ...init,
      });
    } catch {
      throw { stage: `${stage}-network`, authenticationAttempted };
    }
    if (!response.ok || response.redirected || response.type === "opaqueredirect") {
      throw { stage: `${stage}-http-${response.status}`, authenticationAttempted };
    }
    const mediaType = (response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const acceptedMediaType = stage === "login"
      ? ["application/octet-stream", "application/json", "text/json"].includes(mediaType)
      : mediaType === "application/json";
    if (!acceptedMediaType) {
      throw { stage: `${stage}-content-type`, authenticationAttempted };
    }
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      throw { stage: `${stage}-oversize`, authenticationAttempted };
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw { stage: `${stage}-json`, authenticationAttempted };
    }
    return { response, raw, data };
  };

  const form = new URLSearchParams();
  form.set("fldUserID", `${credential.branchNumber}${credential.accountNumber}`);
  form.set("password", credential.powerDirectPassword);
  form.set("langCode", "JAP");
  form.set("mode", "1");
  form.set("postubFlag", "0");
  form.set("jsc", jsc);
  form.set("forward", "");
  form.set("userAgentInfo", navigator.userAgent);

  let login;
  try {
    login = await fetchText(
      "/SFC/app/ShinseiAuthenticatorRealm/login_auth_request_url",
      {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: form.toString(),
      },
      "login",
      true,
    );
  } catch (error) {
    return fail(error.stage || "login-failed", true);
  } finally {
    credential.powerDirectPassword = "";
    jsc = "";
    input.value = "";
  }
  const authorization = login.response.headers.get("authorization");
  const loginBody = login.data && login.data.responseJSON;
  if (
    !hasExactKeys(login.data, ["responseJSON"]) ||
    !hasExactKeys(loginBody, ["authStatus", "token"]) ||
    !loginBody ||
    loginBody.authStatus !== "success" ||
    typeof loginBody.token !== "string" ||
    loginBody.token.length === 0 ||
    typeof authorization !== "string" ||
    authorization.length === 0
  ) {
    return fail("login-rejected", true);
  }
  let csrfToken = loginBody.token;

  const read = async (path, body, stage) => {
    const result = await fetchText(
      path,
      {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Authorization": authorization,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "X-Requested-With": "XMLHttpRequest",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      stage,
      true,
    );
    const nextToken = result.data && result.data.header && result.data.header.newToken;
    if (nextToken !== undefined) {
      if (typeof nextToken !== "string" || nextToken.length === 0) {
        throw { stage: `${stage}-invalid-token`, authenticationAttempted: true };
      }
      csrfToken = nextToken;
    }
    return result;
  };

  try {
    const security = await read(
      "/SFC/app/IFCM_CommonAdapter/securityConnect",
      undefined,
      "security-connect",
    );
    if (
      !hasExactKeys(security.data, ["userId", "attributes"]) ||
      !hasExactKeys(security.data.attributes, [
        "lastLoginTime",
        "createtime",
        "nationalId",
        "systemCode",
        "langCode",
        "AILG04_Login",
        "sessionId",
      ])
    ) {
      return fail("security-connect-shape", true);
    }
    const validation = await read(
      "/SFC/app/IFCM_CommonAdapter/validateToken",
      undefined,
      "validate-token",
    );
    if (
      !hasExactKeys(validation.data, ["header"]) ||
      !hasExactKeys(validation.data.header, ["adapterResultCode", "newToken"]) ||
      validation.data.header.adapterResultCode !== "0" ||
      typeof validation.data.header.newToken !== "string"
    ) {
      return fail("validate-token-shape", true);
    }
    csrfToken = validation.data.header.newToken;

    const topBalances = await read(
      "/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity",
      undefined,
      "top-balances",
    );
    const balanceSummary = await read(
      "/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage",
      undefined,
      "balance-summary",
    );
    const exchangeRate = await read(
      "/SFC/app/IFCM_CommonAdapter/getExchangeRate",
      undefined,
      "exchange-rate",
    );
    const yenDeposit = await read(
      "/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount",
      { requestParam: { screenGroupID: "CTYD0004" } },
      "yen-deposit",
    );
    for (const result of [topBalances, balanceSummary, exchangeRate, yenDeposit]) {
      if (!result.data || !result.data.header || result.data.header.adapterResultCode !== "0") {
        return fail("core-read-result-code", true);
      }
    }
    return {
      ok: true,
      responses: {
        topBalances: topBalances.raw,
        balanceSummary: balanceSummary.raw,
        exchangeRate: exchangeRate.raw,
        yenDeposit: yenDeposit.raw,
      },
    };
  } catch (error) {
    return fail(error.stage || "read-failed", true);
  } finally {
    csrfToken = "";
  }
})()
'@
    $Expression = $ExpressionTemplate.Replace("__CREDENTIAL_BASE64__", $CredentialBase64)
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
        return @{ ok = $false; stage = "cdp-evaluation"; authenticationAttempted = $false }
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

$CredentialJson = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($CredentialJson) -or $CredentialJson.Length -gt 4096) {
  throw "Credential input was missing or oversized"
}
$CredentialBase64 = [Convert]::ToBase64String(
  [System.Text.Encoding]::UTF8.GetBytes($CredentialJson)
)
$CredentialJson = ""

$Targets = Invoke-RestMethod -Uri "$CdpBaseUrl/json/list" -Method Get -TimeoutSec 5
$Candidates = @($Targets | Where-Object {
  $_.type -eq "page" -and
  $_.url -like "$ExpectedOrigin/*" -and
  $_.webSocketDebuggerUrl
})
foreach ($Target in $Candidates) {
  $Result = Invoke-CollectionEvaluation `
    -WebSocketUrl $Target.webSocketDebuggerUrl `
    -CredentialBase64 $CredentialBase64 `
    -TimeoutSeconds $TimeoutSeconds
  if ($null -ne $Result -and $Result.ok -eq $true) {
    [Console]::Out.WriteLine(
      ($Result | ConvertTo-Json -Depth 12 -Compress)
    )
    exit 0
  }
  if ($null -ne $Result -and $Result.authenticationAttempted -eq $true) {
    throw "Chrome-context collection stopped after one authentication attempt"
  }
}
throw "No SBI Shinsei login tab was ready for same-context collection"
