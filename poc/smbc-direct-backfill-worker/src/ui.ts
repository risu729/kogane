export function renderUi(options: { nonce: string }): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SMBC Direct backfill</title>
  <style nonce="${options.nonce}">
    :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    body{max-width:760px;margin:0 auto;padding:32px 20px 64px;background:#f5f6f8;color:#17202a}
    main{background:#fff;border:1px solid #dde2e7;border-radius:18px;padding:28px;box-shadow:0 8px 30px #16202a12}
    h1{font-size:1.55rem;margin:0 0 8px}p{line-height:1.6}.muted{color:#607080}
    .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.button{font:inherit;font-weight:700;padding:11px 17px;border:0;border-radius:11px;cursor:pointer;background:#087f5b;color:#fff}.button.secondary{background:#334155}.button:disabled{opacity:.5;cursor:not-allowed}
    #qr{display:none;margin:24px 0;padding:18px;border:1px solid #d8dee5;border-radius:14px;text-align:center;background:#fff;color:#17202a}#qr img{width:min(320px,100%);height:auto}#qr a{word-break:break-all}
    #status{white-space:pre-wrap;background:#f0f3f5;border-radius:12px;padding:14px;margin-top:20px;min-height:4em}
    @media(max-width:560px){main{padding:20px}}
    @media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}main{background:#18212f;border-color:#334155}.muted{color:#a9b5c3}#status{background:#111827}}
  </style>
</head>
<body>
<main>
  <h1>SMBC Direct backfill</h1>
  <p class="muted">QRを生成し、三井住友銀行アプリで承認後に、取得可能な全期間を収集します。送金操作は実装していません。</p>
  <div class="actions">
    <button class="button" id="generate" type="button">QRを生成</button>
    <button class="button secondary" id="finish" type="button" disabled>承認済み・backfill開始</button>
  </div>
  <section id="qr">
    <img id="qr-image" alt="SMBCアプリ承認用QRコード">
    <p><a id="app-link">この端末でSMBCアプリを開く</a></p>
    <p class="muted" id="expires"></p>
  </section>
  <div id="status" role="status" aria-live="polite">状態を取得しています…</div>
</main>
<script nonce="${options.nonce}">
const byId=(id)=>document.getElementById(id);
const status=byId("status");
const generate=byId("generate");
const finish=byId("finish");
let timer=null;
const request=async(path,body)=>{
  const response=await fetch(path,{method:body?"POST":"GET",headers:body?{"content-type":"application/json","x-kogane-action":"1"}:{},body:body?JSON.stringify(body):undefined});
  const value=await response.json();
  if(!response.ok)throw new Error(value.errorCode||"request_failed");
  return value;
};
const showProgress=(progress)=>{
  const labels={idle:"未開始",waiting_for_approval:"アプリ承認待ち",running:"取得中",success:"完了",partial:"一部取得",failed:"失敗"};
  const lines=["状態: "+(labels[progress.phase]||progress.phase)];
  if(progress.runId)lines.push("Run ID: "+progress.runId);
  if(progress.totalChunks)lines.push("期間: "+progress.completedChunks+" / "+progress.totalChunks);
  if(progress.phase!=="idle"&&progress.phase!=="waiting_for_approval")lines.push("明細: "+progress.transactionCount+"件", "保存物: "+progress.artifactCount+"件");
  if(progress.lastErrorCode)lines.push("エラー: "+progress.lastErrorCode);
  if(progress.manifestKey)lines.push("Manifest: "+progress.manifestKey);
  status.textContent=lines.join("\\n");
  if(progress.phase==="running")startPolling();else stopPolling();
};
const refresh=async()=>showProgress(await request("/api/status"));
const startPolling=()=>{if(!timer)timer=setInterval(()=>refresh().catch(showError),3000)};
const stopPolling=()=>{if(timer){clearInterval(timer);timer=null}};
const showError=(error)=>{status.textContent="エラー: "+error.message};
generate.addEventListener("click",async()=>{
  generate.disabled=true;status.textContent="QRを生成しています…";
  try{
    const result=await request("/api/start",{});
    byId("qr-image").src=result.qrSvgDataUrl;
    byId("app-link").href=result.appUrl;
    byId("expires").textContent="有効期限: "+new Date(result.expiresAt).toLocaleString("ja-JP");
    byId("qr").style.display="block";finish.disabled=false;
    status.textContent="SMBCアプリでQRを承認してください。承認後、backfill開始を押します。";
  }catch(error){showError(error)}finally{generate.disabled=false}
});
finish.addEventListener("click",async()=>{
  finish.disabled=true;status.textContent="承認を確認しています…";
  try{
    const result=await request("/api/finish",{});
    showProgress(result.progress);
    if(result.phase==="waiting_for_approval")finish.disabled=false;
  }catch(error){showError(error);finish.disabled=false}
});
refresh().catch(showError);
</script>
</body>
</html>`;
}
