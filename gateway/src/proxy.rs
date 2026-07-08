//! The proxy core: accept a connection, answer /healthz, and for CONNECT
//! terminate TLS (via `tls`) then forward each decrypted request upstream,
//! streaming the response back. P1 forwards everything (no judge yet — that's
//! P2). Ports the server + forward loop in `src/gateway.ts`. docs/rust-port.md.

use crate::ca::Ca;
use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1 as server_http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::sync::Arc;
use tokio_rustls::TlsAcceptor;

pub type BErr = Box<dyn std::error::Error + Send + Sync>;
pub type Body = BoxBody<Bytes, BErr>;
pub type UpstreamClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, Body>;

fn full(s: &str) -> Body {
    Full::new(Bytes::from(s.to_string()))
        .map_err(|never| match never {})
        .boxed()
}

fn empty() -> Body {
    Empty::<Bytes>::new().map_err(|never| match never {}).boxed()
}

pub fn build_client() -> UpstreamClient {
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_native_roots()
        .expect("load native root certs")
        .https_or_http()
        .enable_http1()
        .build();
    Client::builder(TokioExecutor::new()).build(https)
}

/// Serve one accepted TCP connection.
pub async fn serve(stream: tokio::net::TcpStream, tls: TlsAcceptor, client: UpstreamClient, _ca: Arc<Ca>) {
    let io = TokioIo::new(stream);
    let svc = service_fn(move |req| outer(req, tls.clone(), client.clone()));
    if let Err(e) = server_http1::Builder::new()
        .serve_connection(io, svc)
        .with_upgrades()
        .await
    {
        let _ = e; // connection-level errors (client hangups) are not interesting
    }
}

/// Requests arriving on the raw (untunneled) connection: health, CONNECT, or
/// an absolute-form http proxy request.
async fn outer(req: Request<Incoming>, tls: TlsAcceptor, client: UpstreamClient) -> Result<Response<Body>, BErr> {
    if req.method() == Method::CONNECT {
        let authority = req.uri().authority().map(|a| a.to_string()).unwrap_or_default();
        let host = authority.split(':').next().unwrap_or("").to_string();
        tokio::spawn(async move {
            let upgraded = match hyper::upgrade::on(req).await {
                Ok(u) => u,
                Err(_) => return,
            };
            let tls_stream = match tls.accept(TokioIo::new(upgraded)).await {
                Ok(s) => s,
                Err(_) => return, // client refused our cert (pinning) — P2 adds the tunnel escape hatch
            };
            let io = TokioIo::new(tls_stream);
            let svc = service_fn(move |r| forward(r, host.clone(), client.clone()));
            let _ = server_http1::Builder::new().serve_connection(io, svc).await;
        });
        // hyper sends this 200, then resolves the upgrade above.
        Ok(Response::new(empty()))
    } else if req.uri().path() == "/healthz" {
        let mut resp = Response::new(full("{\"ok\":true}"));
        resp.headers_mut()
            .insert(hyper::header::CONTENT_TYPE, "application/json".parse().unwrap());
        Ok(resp)
    } else if req.uri().scheme_str() == Some("http") {
        let host = req.uri().host().unwrap_or("").to_string();
        forward(req, host, client).await
    } else {
        let mut resp = Response::new(full("{\"error\":\"not a proxy request\"}"));
        *resp.status_mut() = StatusCode::BAD_REQUEST;
        Ok(resp)
    }
}

/// Forward one (already-decrypted) request to the real host and stream the
/// response back. P1: allow all. P2 inserts the judge before this.
async fn forward(req: Request<Incoming>, host: String, client: UpstreamClient) -> Result<Response<Body>, BErr> {
    let (mut parts, body) = req.into_parts();
    let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    parts.uri = if parts.uri.scheme().is_some() {
        parts.uri.clone()
    } else {
        format!("https://{host}{pq}").parse()?
    };
    parts.headers.remove(hyper::header::PROXY_AUTHORIZATION);

    let out = Request::from_parts(parts, body.map_err(|e| Box::new(e) as BErr).boxed());
    match client.request(out).await {
        Ok(resp) => {
            let (parts, body) = resp.into_parts();
            Ok(Response::from_parts(parts, body.map_err(|e| Box::new(e) as BErr).boxed()))
        }
        Err(err) => {
            let mut resp = Response::new(full(&format!("{{\"error\":\"upstream: {err}\"}}")));
            *resp.status_mut() = StatusCode::BAD_GATEWAY;
            Ok(resp)
        }
    }
}
