//! S3-compatible upload for gallery sharing.

use super::config::ShareUploadConfig;
use super::credentials::S3Credentials;
use super::s3_signer;

/// Upload a file to S3 with signed headers.
pub async fn upload_file(
    config: &ShareUploadConfig,
    creds: &S3Credentials,
    key: &str,
    body: &[u8],
    content_type: &str,
    cache_control: Option<&str>,
) -> Result<(), String> {
    let (url, headers) = s3_signer::sign_put_object(
        &config.endpoint_url,
        &config.bucket,
        key,
        &config.region,
        &creds.access_key_id,
        &creds.secret_access_key,
        body,
        content_type,
        cache_control,
    );

    let client = reqwest::Client::new();
    let mut request = client.put(&url).body(body.to_vec());
    for (name, value) in &headers {
        request = request.header(name.as_str(), value.as_str());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Upload failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("S3 upload failed ({}): {}", status, body));
    }

    Ok(())
}

/// Delete a file from S3.
pub async fn delete_file(
    config: &ShareUploadConfig,
    creds: &S3Credentials,
    key: &str,
) -> Result<(), String> {
    let (url, headers) = s3_signer::sign_delete_object(
        &config.endpoint_url,
        &config.bucket,
        key,
        &config.region,
        &creds.access_key_id,
        &creds.secret_access_key,
    );

    let client = reqwest::Client::new();
    let mut request = client.delete(&url);
    for (name, value) in &headers {
        request = request.header(name.as_str(), value.as_str());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Delete failed: {}", e))?;

    if !response.status().is_success() && response.status().as_u16() != 404 {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("S3 delete failed ({}): {}", status, body));
    }

    Ok(())
}

/// Upload and then delete a test object to verify S3 configuration.
pub async fn test_upload(
    config: &ShareUploadConfig,
    creds: &S3Credentials,
) -> Result<(), String> {
    let prefix = normalize_prefix(&config.path_prefix);
    let key = format!("{}.astra-test-{}", prefix, chrono::Utc::now().timestamp());
    let body = b"astra-share-test";

    upload_file(config, creds, &key, body, "text/plain", None).await?;

    // Best-effort cleanup
    let _ = delete_file(config, creds, &key).await;

    Ok(())
}

/// Build the full S3 key for a share file.
pub fn share_key(config: &ShareUploadConfig, share_id: &str, filename: &str) -> String {
    let prefix = normalize_prefix(&config.path_prefix);
    format!("{}{}/{}", prefix, share_id, filename)
}

/// Build the public URL for a share.
pub fn public_url(config: &ShareUploadConfig, share_id: &str) -> String {
    let base = config.public_url_base.trim_end_matches('/');
    let prefix = normalize_prefix(&config.path_prefix);
    format!("{}/{}{}", base, prefix, share_id)
}

/// Upload a file to a presigned URL (for astra.gallery authenticated uploads).
pub async fn upload_file_presigned(
    presigned_url: &str,
    body: &[u8],
    content_type: &str,
) -> Result<(), String> {
    log::info!("Presigned upload to: {}", &presigned_url[..presigned_url.len().min(120)]);
    let client = reqwest::Client::new();
    let response = client
        .put(presigned_url)
        .header("Content-Type", content_type)
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| format!("Presigned upload failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Presigned upload failed ({}): {}", status, body));
    }

    Ok(())
}

fn normalize_prefix(prefix: &str) -> String {
    if prefix.is_empty() {
        return String::new();
    }
    let mut p = prefix.to_string();
    if !p.ends_with('/') {
        p.push('/');
    }
    p
}
