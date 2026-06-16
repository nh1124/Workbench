import { ensureCoreSchema, getCorePool } from "./db.js";

export type OAuthDynamicClientGrantType = "authorization_code" | "refresh_token";

export interface OAuthDynamicClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: OAuthDynamicClientGrantType[];
  responseTypes: "code"[];
  createdAtMs: number;
}

type OAuthDynamicClientRow = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  created_at: string;
};

function toRecord(row: OAuthDynamicClientRow): OAuthDynamicClientRecord {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    tokenEndpointAuthMethod: "none",
    grantTypes: row.grant_types.filter(
      (value): value is OAuthDynamicClientGrantType => value === "authorization_code" || value === "refresh_token"
    ),
    responseTypes: ["code"],
    createdAtMs: new Date(row.created_at).getTime()
  };
}

export async function saveOAuthDynamicClient(input: {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: OAuthDynamicClientGrantType[];
  responseTypes: "code"[];
}): Promise<OAuthDynamicClientRecord> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<OAuthDynamicClientRow>(
    `
      INSERT INTO oauth_dynamic_clients (
        client_id, client_name, redirect_uris, token_endpoint_auth_method, grant_types, response_types
      )
      VALUES ($1, $2, $3::text[], $4, $5::text[], $6::text[])
      ON CONFLICT (client_id)
      DO UPDATE SET
        client_name = EXCLUDED.client_name,
        redirect_uris = EXCLUDED.redirect_uris,
        token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
        grant_types = EXCLUDED.grant_types,
        response_types = EXCLUDED.response_types
      RETURNING client_id, client_name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, created_at
    `,
    [
      input.clientId,
      input.clientName,
      input.redirectUris,
      input.tokenEndpointAuthMethod,
      input.grantTypes,
      input.responseTypes
    ]
  );
  return toRecord(result.rows[0]);
}

export async function getOAuthDynamicClient(clientId: string): Promise<OAuthDynamicClientRecord | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<OAuthDynamicClientRow>(
    `
      SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, created_at
      FROM oauth_dynamic_clients
      WHERE client_id = $1
      LIMIT 1
    `,
    [clientId]
  );
  return result.rows[0] ? toRecord(result.rows[0]) : undefined;
}
