/**
 * Shared browser runtime for the AI chat widget.
 *
 * The SAME markup, CSS and browser JS power two delivery paths:
 *   1. The `chat-widget` Portable Text block (src/astro/ChatWidget.astro), which
 *      an editor drops onto a specific page.
 *   2. The site-wide auto-injected floating bubble (page:fragments hook in
 *      native.ts), which appears on every public page with NO source edits.
 *
 * Keeping the strings here means one source of truth for the widget behaviour.
 * Everything returned is plain, framework-agnostic HTML/CSS/JS.
 *
 * NB: the browser JS is emitted as a STRING (it is injected verbatim into an
 * inline <script>), so it must stay valid ES5-ish browser JavaScript with NO
 * TypeScript syntax.
 */

export interface WidgetConfig {
  /** Panel header. */
  title: string;
  /** Input placeholder. */
  placeholder: string;
  /** First assistant bubble. */
  welcome: string;
  /** Accent colour (hex). */
  accent: string;
  /** "floating" launcher + panel, or "inline" panel. */
  mode: "floating" | "inline";
  /** Public chat route. */
  endpoint: string;
  /** Public streaming route. */
  streamEndpoint: string;
  /** Optional collections to scope retrieval. */
  collections: string[];
  /** DOM id root (unique per instance). */
  uid: string;
}

const DEFAULT_ENDPOINT = "/_emdash/api/plugins/ai-search/chat";

/** Fill defaults + derive the stream endpoint. */
export function resolveWidgetConfig(input: Partial<WidgetConfig> & { uid: string }): WidgetConfig {
  const endpoint = input.endpoint || DEFAULT_ENDPOINT;
  return {
    uid: input.uid,
    title: input.title || "Ask about this site",
    placeholder: input.placeholder || "Type your question…",
    welcome: input.welcome || "Hi! Ask me anything about this site.",
    accent: input.accent || "#465fff",
    mode: input.mode === "inline" ? "inline" : "floating",
    endpoint,
    streamEndpoint:
      input.streamEndpoint || (endpoint.endsWith("/chat") ? endpoint + "/stream" : endpoint + "/chat/stream"),
    collections: Array.isArray(input.collections) ? input.collections.map(String) : [],
  };
}

/** HTML-escape a value for safe interpolation into markup/attributes. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The widget's stylesheet (shared). */
export function widgetStyles(): string {
  return `
  .aisearch-chat--floating { position: fixed; right: 20px; bottom: 20px; z-index: 9999; }
  .aisearch-chat__launch {
    width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
    background: var(--aisearch-accent, #465fff); color: #fff; font-size: 24px; line-height: 1;
    box-shadow: 0 4px 16px rgba(0,0,0,.2);
  }
  .aisearch-chat--floating.is-open .aisearch-chat__launch { display: none; }
  .aisearch-chat__panel[hidden] { display: none !important; }
  .aisearch-chat--floating .aisearch-chat__panel {
    position: fixed; right: 20px; bottom: 20px; width: 360px; max-width: calc(100vw - 40px);
    height: 480px; max-height: calc(100vh - 120px); display: flex; flex-direction: column;
    border-radius: 12px; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,.18);
    border: 1px solid #e5e7eb; background: #fff;
  }
  .aisearch-chat--inline .aisearch-chat__panel {
    display: flex; flex-direction: column; width: 100%; height: 520px; border-radius: 12px;
    overflow: hidden; border: 1px solid #e5e7eb; background: #fff;
  }
  .aisearch-chat__header {
    display: flex; align-items: center; justify-content: space-between; padding: 12px 14px;
    background: var(--aisearch-accent, #465fff); color: #fff; font-weight: 600; font-size: 14px; flex: 0 0 auto;
  }
  .aisearch-chat__close {
    background: transparent; border: none; color: #fff; cursor: pointer; font-size: 16px;
    line-height: 1; padding: 2px 6px;
  }
  .aisearch-chat__mount { flex: 1 1 auto; min-height: 0; display: flex; }
  .aisearch-chat__deepchat {
    flex: 1 1 auto; min-height: 0;
    --deep-chat-text-color: #1f2937; --deep-chat-background-color: #ffffff;
  }`;
}

/** The widget's HTML shell (launcher + panel + mount). */
export function widgetMarkup(cfg: WidgetConfig): string {
  const isFloating = cfg.mode !== "inline";
  const modeClass = isFloating ? "aisearch-chat--floating" : "aisearch-chat--inline";
  const config = JSON.stringify({
    endpoint: cfg.endpoint,
    streamEndpoint: cfg.streamEndpoint,
    collections: cfg.collections,
  });
  return (
    `<div class="aisearch-chat ${modeClass}" id="${esc(cfg.uid)}-root" data-uid="${esc(cfg.uid)}"` +
    ` data-config="${esc(config)}" style="--aisearch-accent:${esc(cfg.accent)}">` +
    (isFloating
      ? `<button type="button" class="aisearch-chat__launch" aria-label="Open chat" data-role="launch">💬</button>`
      : "") +
    `<div class="aisearch-chat__panel" data-role="panel"${isFloating ? " hidden" : ""}>` +
    `<div class="aisearch-chat__header"><span>${esc(cfg.title)}</span>` +
    (isFloating
      ? `<button type="button" class="aisearch-chat__close" aria-label="Close chat" data-role="close">✕</button>`
      : "") +
    `</div>` +
    `<div class="aisearch-chat__mount" data-role="mount"` +
    ` data-welcome="${esc(cfg.welcome)}" data-placeholder="${esc(cfg.placeholder)}"` +
    ` data-accent="${esc(cfg.accent)}"></div>` +
    `</div></div>`
  );
}

/**
 * The widget's browser wiring, as a plain-JS string. `uid` is baked in.
 * Deep Chat must already be defined (loaded via the bundle / npm import).
 */
export function widgetScript(uid: string): string {
  const UID = JSON.stringify(uid);
  return `(function(){
  var uid = ${UID};
  var root = document.getElementById(uid + "-root");
  if (!root || root.getAttribute("data-aisearch-init")) return;
  root.setAttribute("data-aisearch-init", "1");
  var mount = root.querySelector('[data-role="mount"]');
  if (!mount) return;
  var cfg = {};
  try { cfg = JSON.parse(root.getAttribute("data-config") || "{}"); } catch (e) { cfg = {}; }
  var endpoint = cfg.endpoint;
  var streamEndpoint = cfg.streamEndpoint;
  var collections = Array.isArray(cfg.collections) ? cfg.collections : [];

  var launch = root.querySelector('[data-role="launch"]');
  var closeBtn = root.querySelector('[data-role="close"]');
  var panel = root.querySelector('[data-role="panel"]');
  function open(){ if(panel) panel.hidden=false; root.classList.add("is-open"); }
  function hide(){ if(panel) panel.hidden=true; root.classList.remove("is-open"); }
  if (launch) launch.addEventListener("click", function(){ if(panel && panel.hidden) open(); else hide(); });
  if (closeBtn) closeBtn.addEventListener("click", hide);

  function questionFrom(body){
    var msgs = body && body.messages;
    if (!Array.isArray(msgs) || !msgs.length) return "";
    for (var i=msgs.length-1;i>=0;i--){ if(msgs[i]&&typeof msgs[i].text==="string"&&msgs[i].text.trim()) return msgs[i].text.trim(); }
    return "";
  }
  function citationsMarkdown(cs){
    if(!Array.isArray(cs)||!cs.length) return "";
    var parts = cs.filter(function(c){return c&&c.title;}).map(function(c){return String(c.title);});
    return parts.length ? ("\\n\\nSources: " + parts.join(", ")) : "";
  }
  function tryStream(reqBody, signals){
    if(!streamEndpoint) return Promise.resolve(false);
    return fetch(streamEndpoint,{method:"POST",headers:{"Content-Type":"application/json",Accept:"text/event-stream"},body:JSON.stringify(reqBody)})
      .then(function(res){
        var ct=res.headers.get("content-type")||"";
        if(!res.ok||!res.body||ct.indexOf("text/event-stream")===-1) return false;
        signals.onOpen();
        var reader=res.body.getReader(), decoder=new TextDecoder(), buf="", produced=false;
        function pump(){ return reader.read().then(function(r){
          if(r.done) return produced;
          buf+=decoder.decode(r.value,{stream:true});
          var idx;
          while((idx=buf.indexOf("\\n\\n"))!==-1){
            var evt=buf.slice(0,idx); buf=buf.slice(idx+2);
            var dataLine=null, lines=evt.split("\\n");
            for(var i=0;i<lines.length;i++){ if(lines[i].indexOf("data:")===0){dataLine=lines[i];break;} }
            if(!dataLine) continue;
            var payload=dataLine.slice(5).trim();
            if(payload==="[DONE]") return produced;
            try{ var obj=JSON.parse(payload);
              if(obj.delta){ produced=true; signals.onResponse({text:obj.delta}); }
              else if(obj.citations){ var md=citationsMarkdown(obj.citations); if(md){produced=true; signals.onResponse({text:md});} }
              else if(obj.error){ signals.onResponse({error:String(obj.error)}); return true; }
            }catch(e){}
          }
          return pump();
        }); }
        return pump();
      }).catch(function(){ return false; });
  }
  function singleResponse(reqBody, signals){
    return fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(reqBody)})
      .then(function(res){ return res.json().catch(function(){return {};}).then(function(json){
        var payload = json && json.data ? json.data : json;
        if(!res.ok || (json && json.success===false)){
          var msg = (payload && payload.error && (payload.error.message||payload.error)) ||
            (res.status===429 ? "Too many requests — please slow down." :
             res.status===403 ? "This chat only works from the site itself." : "Sorry, something went wrong.");
          signals.onResponse({error:String(msg)}); return;
        }
        if(payload && payload.answer){ signals.onResponse({text: payload.answer + citationsMarkdown(payload.citations)}); }
        else if(payload && payload.error){ signals.onResponse({error:String(payload.error.message||payload.error)}); }
        else { signals.onResponse({error:"Sorry, something went wrong."}); }
      }); }).catch(function(){ signals.onResponse({error:"Network error — please try again."}); });
  }
  var requestConfig = { handler: function(body, signals){
    var question = questionFrom(body);
    if(!question){ signals.onResponse({error:"Please type a question."}); return; }
    var reqBody = { question: question };
    if(collections.length) reqBody.filters = { collections: collections };
    tryStream(reqBody, signals).then(function(streamed){
      if(streamed){ signals.onClose(); return; }
      return singleResponse(reqBody, signals).then(function(){ signals.onClose(); });
    }).catch(function(){ signals.onResponse({error:"Sorry, something went wrong."}); signals.onClose(); });
  }};
  function mountChat(){
    var chat = document.createElement("deep-chat");
    chat.id = uid;
    chat.className = "aisearch-chat__deepchat";
    chat.request = requestConfig;
    chat.stream = { simulation: true };
    chat.introMessage = { text: mount.getAttribute("data-welcome") || "" };
    chat.textInput = { placeholder: { text: mount.getAttribute("data-placeholder") || "" } };
    var accent = mount.getAttribute("data-accent") || "#465fff";
    chat.style.cssText = "--deep-chat-accent-color:" + accent + ";border:none;width:100%;height:100%;background-color:transparent;";
    mount.appendChild(chat);
  }
  if (window.customElements && customElements.whenDefined) { customElements.whenDefined("deep-chat").then(mountChat); }
  else { mountChat(); }
})();`;
}
