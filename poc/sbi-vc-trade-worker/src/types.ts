export interface SessionMaterial {
  cookies: {
    vctBffSid: string;
    jSessionId: string;
    awsAlbApp: [string, string, string, string];
    awsAlb: string;
    awsAlbCors: string;
  };
  secureKey: string;
}

export interface EncryptedSession {
  version: 1;
  iv: string;
  ciphertext: string;
}

export interface HealthState {
  initializedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastHttpStatus: number | null;
  lastGatewayStatus: string | null;
  lastCookieUpdateCount: number;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastReauthAttemptAt: string | null;
  lastReauthSuccessAt: string | null;
  lastReauthErrorCode: string | null;
}

export interface GatewayMeta {
  status: string;
  secureKey?: string;
}

export interface PasskeyCredential {
  credentialId: string;
  keyValue: string;
  rpId: "sbivc.co.jp";
  userHandle: string;
  counter: 0;
  keyAlgorithm: "ECDSA";
  keyCurve: "P-256";
}
