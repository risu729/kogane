export type JsonObject = Record<string, unknown>;

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

export interface GatewayEnvelope<T = unknown> {
  meta: {
    sessUpdTime?: string;
    status: string;
    timestamp?: string;
  };
  body: T;
}

export interface Artifact {
  name: string;
  response: GatewayEnvelope;
}

export interface CollectionOptions {
  pageSize?: number;
  maxPages?: number;
}
