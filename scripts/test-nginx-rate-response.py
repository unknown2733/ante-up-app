"""Real nginx fixture: no production routes, published ports, keys or network."""
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time

image = sys.argv[1] if len(sys.argv) > 1 else "jc21/nginx-proxy-manager"
assert re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9/_.:@-]+", image)
root = pathlib.Path(__file__).resolve().parents[1]
parent = root / ".runtime/nginx-rate-fixture"
parent.mkdir(parents=True, exist_ok=True)
directory = pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=parent))
name = "ante-up-rate-fixture-" + str(time.time_ns())


def docker(*args):
    return subprocess.run(["docker", *args], check=True, capture_output=True, text=True).stdout


snippet = (root / "deploy/nginx/ante-up-rate-limit-response.conf").read_text(encoding="utf-8")
assert not re.search(r"^\s*limit_req(?:_zone|_status)?\s", snippet, re.M)
(directory / "rate-response.conf").write_text(snippet, encoding="utf-8")
(directory / "ok.json").write_text("{}", encoding="utf-8")
(directory / "nginx.conf").write_text("""worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {worker_connections 64;}
http {
 access_log off;
 client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy;
 fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;
 limit_req_zone $binary_remote_addr zone=baseline:1m rate=3r/s;
 limit_req_zone $binary_remote_addr zone=ante_up_api:1m rate=3r/s;
 server {listen 127.0.0.1:8181; location /ready {return 200 'ready';}
  location /api/ {limit_req zone=baseline burst=12 nodelay;limit_req_status 429;root /fixture;try_files /ok.json =404;}}
 server {listen 127.0.0.1:8182;include /fixture/rate-response.conf;
  location = /api/upstream429 {proxy_intercept_errors off;proxy_pass http://127.0.0.1:8183;}
  location /api/ {limit_req zone=ante_up_api burst=12 nodelay;limit_req_status 429;root /fixture;try_files /ok.json =404;}}
 server {listen 127.0.0.1:8183;location / {default_type application/json;add_header Retry-After 7 always;return 429 '{"code":"UPSTREAM_RATE_LIMITED"}';}}
}
""", encoding="utf-8")
started = False
try:
    docker("run", "--rm", "--pull", "never", "-d", "--name", name, "--network", "none", "--read-only",
           "--user", "1000:1000", "--cap-drop", "ALL", "--tmpfs", "/tmp:rw,uid=1000,gid=1000",
           "-v", str(directory) + ":/fixture:ro", "--entrypoint", "/usr/sbin/nginx", image,
           "-p", "/tmp/", "-c", "/fixture/nginx.conf", "-g", "daemon off;")
    started = True
    for attempt in range(30):
        try:
            docker("exec", name, "node", "-e", "fetch('http://127.0.0.1:8181/ready').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))")
            break
        except subprocess.CalledProcessError:
            if attempt == 29:
                raise
            time.sleep(0.1)
    report = json.loads(docker("exec", name, "node", "--input-type=module", "-e", """
      const outputs=[];
      for(const port of [8181,8182]){
        const rows=[];
        for(let i=0;i<18;i++){const r=await fetch('http://127.0.0.1:'+port+'/api/fixture');rows.push({status:r.status,retryAfter:r.headers.get('retry-after'),contentType:r.headers.get('content-type'),cache:r.headers.get('cache-control'),body:await r.text()});}
        outputs.push({port,rows});
      }
      await new Promise(r=>setTimeout(r,5000));
      const recovered=await fetch('http://127.0.0.1:8182/api/fixture');
      const upstream=await fetch('http://127.0.0.1:8182/api/upstream429');
      console.log(JSON.stringify({outputs,recovered:recovered.status,upstream:{status:upstream.status,retryAfter:upstream.headers.get('retry-after'),body:await upstream.json()}}));
    """))
    for output in report["outputs"]:
        statuses = [row["status"] for row in output["rows"]]
        assert 200 in statuses and 429 in statuses and set(statuses) <= {200, 429}
    before = next(row for row in report["outputs"][0]["rows"] if row["status"] == 429)
    after = next(row for row in report["outputs"][1]["rows"] if row["status"] == 429)
    assert before["retryAfter"] is None and "text/html" in before["contentType"]
    assert after["retryAfter"] == "5" and "application/json" in after["contentType"]
    assert after["cache"] == "no-store"
    assert json.loads(after["body"])["code"] == "HTTP_RATE_LIMITED"
    assert json.loads(after["body"])["retryable"] is True
    assert report["recovered"] == 200
    assert report["upstream"] == {"status": 429, "retryAfter": "7", "body": {"code": "UPSTREAM_RATE_LIMITED"}}
    report["boundary"] = "Ephemeral nginx only; network none; no published port or production mount. Same 3r/s burst12 policy before/after."
    (directory / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"directory": str(directory), "baseline429": before["retryAfter"], "current429": after["retryAfter"],
                      "recovered": report["recovered"], "upstreamPreserved": True, "ratePolicyUnchanged": True}))
finally:
    if started:
        docker("stop", "--time", "1", name)
