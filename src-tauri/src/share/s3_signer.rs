//! AWS Signature V4 signing for S3-compatible PutObject / DeleteObject requests.
//!
//! Supports AWS S3, Cloudflare R2, MinIO, and any S3-compatible endpoint.
//! Uses path-style URLs which work universally.

use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Generate a signed PutObject request.
///
/// Returns `(url, headers)` where headers is a vec of (name, value) pairs
/// that must be sent with the request.
pub fn sign_put_object(
    endpoint: &str,
    bucket: &str,
    key: &str,
    region: &str,
    access_key_id: &str,
    secret_access_key: &str,
    body: &[u8],
    content_type: &str,
    cache_control: Option<&str>,
) -> (String, Vec<(String, String)>) {
    let now = Utc::now();
    let date_stamp = now.format("%Y%m%d").to_string();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();

    // Path-style URL: {endpoint}/{bucket}/{key}
    let endpoint = endpoint.trim_end_matches('/');
    let url = format!("{}/{}/{}", endpoint, bucket, key);
    let uri_path = format!("/{}/{}", bucket, key);

    // Payload hash
    let payload_hash = hex::encode(Sha256::digest(body));

    // Canonical headers (must be sorted)
    let host = extract_host(endpoint);

    let (canonical_headers, signed_headers) = if let Some(cc) = cache_control {
        (
            format!(
                "cache-control:{}\ncontent-type:{}\nhost:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
                cc, content_type, host, payload_hash, amz_date
            ),
            "cache-control;content-type;host;x-amz-content-sha256;x-amz-date".to_string(),
        )
    } else {
        (
            format!(
                "content-type:{}\nhost:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
                content_type, host, payload_hash, amz_date
            ),
            "content-type;host;x-amz-content-sha256;x-amz-date".to_string(),
        )
    };

    // Canonical request
    let canonical_request = format!(
        "PUT\n{}\n\n{}\n{}\n{}",
        uri_path, canonical_headers, signed_headers, payload_hash
    );

    let credential_scope = format!("{}/{}/s3/aws4_request", date_stamp, region);

    // String to sign
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );

    // Signing key
    let signing_key = derive_signing_key(secret_access_key, &date_stamp, region);

    // Signature
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key_id, credential_scope, signed_headers, signature
    );

    let mut headers = vec![
        ("Content-Type".to_string(), content_type.to_string()),
        ("x-amz-date".to_string(), amz_date),
        ("x-amz-content-sha256".to_string(), payload_hash),
        ("Authorization".to_string(), authorization),
    ];

    if let Some(cc) = cache_control {
        headers.push(("Cache-Control".to_string(), cc.to_string()));
    }

    (url, headers)
}

/// Generate a signed DeleteObject request.
pub fn sign_delete_object(
    endpoint: &str,
    bucket: &str,
    key: &str,
    region: &str,
    access_key_id: &str,
    secret_access_key: &str,
) -> (String, Vec<(String, String)>) {
    let now = Utc::now();
    let date_stamp = now.format("%Y%m%d").to_string();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();

    let endpoint = endpoint.trim_end_matches('/');
    let url = format!("{}/{}/{}", endpoint, bucket, key);
    let uri_path = format!("/{}/{}", bucket, key);

    // Empty payload for DELETE
    let payload_hash = hex::encode(Sha256::digest(b""));

    let host = extract_host(endpoint);
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host, payload_hash, amz_date
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";

    let canonical_request = format!(
        "DELETE\n{}\n\n{}\n{}\n{}",
        uri_path, canonical_headers, signed_headers, payload_hash
    );

    let credential_scope = format!("{}/{}/s3/aws4_request", date_stamp, region);

    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );

    let signing_key = derive_signing_key(secret_access_key, &date_stamp, region);
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key_id, credential_scope, signed_headers, signature
    );

    let headers = vec![
        ("x-amz-date".to_string(), amz_date),
        ("x-amz-content-sha256".to_string(), payload_hash),
        ("Authorization".to_string(), authorization),
    ];

    (url, headers)
}

fn derive_signing_key(secret: &str, date_stamp: &str, region: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{}", secret).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac =
        HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn extract_host(endpoint: &str) -> String {
    endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}
