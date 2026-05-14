// SPDX-License-Identifier: AGPL-3.0-or-later
//! Localhost HTTP file server for inline media playback.
//!
//! webkit2gtk's `<video>`/`<audio>` elements on Linux refuse to play through
//! Tauri's custom asset:// URI scheme (MediaError code 4 — SRC_NOT_SUPPORTED)
//! even when the underlying scheme handler serves valid bytes with proper
//! range support. The pragmatic workaround used by most production Tauri-on-
//! Linux media apps is a short-lived HTTP server bound to a random loopback
//! port, used as the `src` for media elements only. Images continue to load
//! through the asset protocol where it works fine.
//!
//! The server binds to `127.0.0.1` (loopback only — never the LAN) and serves
//! one route: `GET /file?path=<urlencoded-absolute-path>`. tower-http's
//! `ServeFile` provides range-request handling and content-type sniffing out
//! of the box.

use axum::{
	extract::Query,
	http::{header, Method, StatusCode},
	response::{IntoResponse, Response},
	routing::get,
	Router,
};
use serde::Deserialize;
use std::path::PathBuf;
use tower::ServiceExt;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeFile;

#[derive(Deserialize)]
struct FileQuery {
	path: String,
}

async fn handle(
	Query(q): Query<FileQuery>,
	req: axum::extract::Request,
) -> Response {
	let path = PathBuf::from(&q.path);
	if !path.is_file() {
		return (StatusCode::NOT_FOUND, "no such file").into_response();
	}
	match ServeFile::new(path).oneshot(req).await {
		Ok(r) => r.into_response(),
		Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "io error").into_response(),
	}
}

/// Bind synchronously to a random loopback port, return the port immediately,
/// and serve in the background on Tauri's tokio runtime. Binding before spawn
/// guarantees the frontend can be told the port before any media URL is
/// constructed.
pub fn spawn() -> std::io::Result<u16> {
	// CORS: the webview's origin (tauri://localhost in prod, http://localhost:5173
	// in dev) is distinct from this server's origin (http://127.0.0.1:<port>), so
	// without CORS headers webkit will taint any canvas drawn from a <video>
	// element backed by this server — `canvas.toDataURL` then throws
	// SecurityError. Allowing any origin is safe because the server only ever
	// binds to loopback.
	let cors = CorsLayer::new()
		.allow_origin(Any)
		.allow_methods([Method::GET, Method::HEAD])
		.allow_headers([header::RANGE]);

	let app = Router::new().route("/file", get(handle)).layer(cors);
	let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
	listener.set_nonblocking(true)?;
	let port = listener.local_addr()?.port();

	tauri::async_runtime::spawn(async move {
		let listener = tokio::net::TcpListener::from_std(listener).unwrap();
		if let Err(e) = axum::serve(listener, app).await {
			tracing::error!("media server: {e}");
		}
	});

	tracing::info!("media server listening on 127.0.0.1:{port}");
	Ok(port)
}
