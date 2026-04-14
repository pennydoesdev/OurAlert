// OurALERT frontend SPA.
// Privacy-first: no third-party analytics, no trackers. All network calls go
// to same-origin /api/*. Map tiles come from OpenStreetMap; nothing else.

(function(){
'use strict';

// ---- config ----
var TURNSTILE_SITE_KEY = ""; // injected on boot from /api/config
var SESSION_KEY = "ouralert.session";
var CATEGORIES = [
  ["ice_activity","ICE activity"],
  ["military_activity","Military activity"],
  ["checkpoint","Checkpoint"],
  ["raid","Raid"],
  ["detention","Detention"],
  ["tip","General tip"]
];

// ---- tiny helpers ----
var $ = function(sel, root){ return (root||document).querySelector(sel); };
var $$ = function(sel, root){ return Array.from((root||document).querySelectorAll(sel)); };
var el = function(tag, attrs, children){
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs){
    if (k === "class") n.className = attrs[k];
    else if (k === "html") n.innerHTML = attrs[k];
    else if (k.slice(0,2) === "on") n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  }
  (children||[]).forEach(function(c){ if (c == null) return; n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return n;
};
var esc = function(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];}); };
var fmtTime = function(iso){
  if (!iso) return "";
  try { var d = new Date(iso); return d.toLocaleString(); } catch(e){ return iso; }
};
var toast = function(msg, ms){
  var t = $(".toast") || document.body.appendChild(el("div",{class:"toast"}));
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove("show"); }, ms||2500);
};
var getSession = function(){ try { return JSON.parse(localStorage.getItem(SESSION_KEY)||"null"); } catch(e){ return null; } };
var setSession = function(s){ if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); };
var authHeaders = function(){ var s = getSession(); return s && s.token ? {"X-OurAlert-Session": s.token} : {}; };

// ---- API client ----
var api = function(path, opts){
  opts = opts || {};
  var headers = Object.assign({"Content-Type":"application/json"}, authHeaders(), opts.headers||{});
  if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData)) opts.body = JSON.stringify(opts.body);
  if (opts.body instanceof FormData) delete headers["Content-Type"];
  return fetch(path, Object.assign({}, opts, {headers:headers, credentials:"same-origin"}))
    .then(function(r){
      var ct = r.headers.get("content-type")||"";
      var p = ct.indexOf("application/json") >= 0 ? r.json() : r.text();
      return p.then(function(body){
        if (!r.ok) { var e = new Error((body && body.error) || r.statusText || "Request failed"); e.status = r.status; e.body = body; throw e; }
        return body;
      });
    });
};

// ---- first-party analytics ----
var analytics = (function(){
  var sid = sessionStorage.getItem("oa_sid");
  if (!sid){ sid = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem("oa_sid", sid); }
  var buf = [];
  var flush = function(){
    if (!buf.length) return;
    var batch = buf.splice(0);
    try {
      if (navigator.sendBeacon){
        navigator.sendBeacon("/api/analytics/batch", new Blob([JSON.stringify({events:batch})], {type:"application/json"}));
      } else {
        fetch("/api/analytics/batch", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({events:batch}),keepalive:true}).catch(function(){});
      }
    } catch(e){}
  };
  var push = function(name, props){
    buf.push({
      event: name,
      session_id: sid,
      path: location.pathname,
      referrer: document.referrer || null,
      ts: Date.now(),
      props: props || null
    });
    if (buf.length >= 10) flush();
  };
  setInterval(flush, 15000);
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  return {track: push, pageview: function(){ push("page_view"); }};
})();

// ---- client-side router ----
var routes = {};
var register = function(path, render){ routes[path] = render; };
var matchRoute = function(path){
  if (routes[path]) return {render:routes[path], params:{}};
  // dynamic: /reports/:id
  var m = path.match(/^\/reports\/([^\/]+)$/);
  if (m) return {render: renderReportDetail, params:{id: m[1]}};
  return {render: renderNotFound, params:{}};
};
var navigate = function(path, replace){
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  render();
};
var render = function(){
  var r = matchRoute(location.pathname);
  var root = $("#view-root"); root.innerHTML = "";
  $$(".primary-nav a").forEach(function(a){ a.classList.toggle("active", a.getAttribute("data-nav") === location.pathname); });
  try { r.render(root, r.params); } catch(e){ console.error(e); root.appendChild(el("div",{class:"card"}, ["Something went wrong: "+e.message])); }
  analytics.pageview();
  window.scrollTo(0,0);
};
document.addEventListener("click", function(e){
  var a = e.target.closest("a[data-nav]");
  if (!a) return;
  var href = a.getAttribute("href");
  if (!href || href.indexOf("http") === 0) return;
  e.preventDefault(); navigate(href);
});
window.addEventListener("popstate", render);

// ---- nav toggle ----
document.addEventListener("click", function(e){
  if (e.target.classList.contains("nav-toggle")){
    var nav = $(".primary-nav"); if (nav) nav.classList.toggle("open");
  }
});

// ---- views ----
function renderHome(root){
  root.appendChild(el("div",{class:"wrap hero"},[
    el("h1",null,["Watch. Report. Protect."]),
    el("p",null,["OurALERT maps community reports of ICE and military enforcement activity in near real time. Submit reports anonymously — no account required."]),
    el("div",{class:"btn-row"},[
      el("a",{class:"btn","href":"/report","data-nav":"/report"},["Report anonymously"]),
      el("a",{class:"btn ghost","href":"/subscribe","data-nav":"/subscribe"},["Get email alerts"])
    ])
  ]));
  var mapWrap = el("div",{class:"wrap"},[
    el("div",{id:"map"}),
    el("div",{class:"map-legend"},[
      el("span",null,[el("span",{class:"legend-dot report"}),"Community reports (24h)"]),
      el("span",null,[el("span",{class:"legend-dot facility"}),"Known detention facilities"])
    ])
  ]);
  root.appendChild(mapWrap);
  root.appendChild(el("div",{class:"wrap",style:"margin-top:1.5rem"},[
    el("h2",null,["Recent reports"]),
    el("div",{id:"recent-list",class:"report-list"},[el("p",{class:"muted"},["Loading…"])])
  ]));
  setTimeout(bootMap, 50);
  loadRecent();
}

function bootMap(){
  if (typeof L === "undefined") return setTimeout(bootMap, 200);
  var map = L.map("map", {scrollWheelZoom:false}).setView([39.5,-98.35], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
    attribution:'&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom:18
  }).addTo(map);
  map.on("focus", function(){ map.scrollWheelZoom.enable(); });
  map.on("blur", function(){ map.scrollWheelZoom.disable(); });
  // Load reports + facilities from our own API (no external geocoding)
  api("/api/reports?status=approved&limit=500").then(function(res){
    var feats = (res.reports||res.items||[]).filter(function(r){ return r.lat && r.lon; });
    feats.forEach(function(r){
      L.circleMarker([r.lat,r.lon],{radius:7,color:"#c8102e",fillColor:"#c8102e",fillOpacity:0.85,weight:1})
        .addTo(map)
        .bindPopup(
          "<h4>"+esc(r.title||r.category||"Report")+"</h4>"+
          "<div class=meta>"+esc(r.city||"")+(r.state?", "+esc(r.state):"")+" · "+esc(fmtTime(r.created_at))+"</div>"+
          (r.activity?"<p>"+esc(String(r.activity).slice(0,240))+"</p>":"")+
          '<a href="/reports/'+encodeURIComponent(r.id)+'" data-nav="/reports/'+encodeURIComponent(r.id)+'">View →</a>'
        );
    });
  }).catch(function(){});
  api("/api/facilities").then(function(res){
    var list = res.facilities || res.items || [];
    list.forEach(function(f){
      if (!f.lat || !f.lon) return;
      L.circleMarker([f.lat,f.lon],{radius:5,color:"#0057a8",fillColor:"#0057a8",fillOpacity:0.7,weight:1})
        .addTo(map)
        .bindPopup("<h4>"+esc(f.name||"Facility")+"</h4><div class=meta>"+esc(f.agency||"")+" · "+esc(f.city||"")+(f.state?", "+esc(f.state):"")+"</div>");
    });
  }).catch(function(){});
}

function loadRecent(){
  var host = $("#recent-list");
  api("/api/reports?status=approved&limit=10").then(function(res){
    var list = res.reports || res.items || [];
    host.innerHTML = "";
    if (!list.length){ host.appendChild(el("p",{class:"muted"},["No approved reports yet. Be the first to contribute."])); return; }
    list.forEach(function(r){
      host.appendChild(el("a",{class:"report-item","href":"/reports/"+encodeURIComponent(r.id),"data-nav":"/reports/"+encodeURIComponent(r.id)},[
        el("h3",null,[r.title || r.category || "Report"]),
        el("div",{class:"report-meta"},[(r.city||"")+(r.state?", "+r.state:"")+" · "+fmtTime(r.created_at)]),
        el("p",null,[String(r.activity||"").slice(0,220)])
      ]));
    });
  }).catch(function(e){ host.innerHTML = ""; host.appendChild(el("p",{class:"error"},["Could not load reports: "+e.message])); });
}

function renderReports(root){
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Reports"]),
    el("div",{class:"filters"},[
      el("select",{id:"f-cat"},[el("option",{value:""},["All categories"])].concat(CATEGORIES.map(function(c){ return el("option",{value:c[0]},[c[1]]); }))),
      el("select",{id:"f-time"},[
        el("option",{value:"24h"},["Last 24h"]),
        el("option",{value:"7d",selected:"selected"},["Last 7 days"]),
        el("option",{value:"30d"},["Last 30 days"]),
        el("option",{value:"all"},["All time"])
      ]),
      el("input",{type:"text",id:"f-q",placeholder:"Search city, activity…"}),
      el("button",{class:"btn small",onclick:function(){ loadReportsList(); }},["Apply"])
    ]),
    el("div",{id:"reports-list",class:"report-list"},[el("p",{class:"muted"},["Loading…"])])
  ]));
  loadReportsList();
}

function loadReportsList(){
  var cat = $("#f-cat") ? $("#f-cat").value : "";
  var t = $("#f-time") ? $("#f-time").value : "7d";
  var q = $("#f-q") ? $("#f-q").value.trim() : "";
  var qs = "?status=approved&limit=50";
  if (cat) qs += "&category="+encodeURIComponent(cat);
  if (t && t !== "all") qs += "&since="+encodeURIComponent(t);
  if (q) qs += "&q="+encodeURIComponent(q);
  var host = $("#reports-list"); host.innerHTML = "<p class=muted>Loading…</p>";
  api("/api/reports"+qs).then(function(res){
    var list = res.reports || res.items || [];
    host.innerHTML = "";
    if (!list.length){ host.appendChild(el("p",{class:"muted"},["No reports match your filters."])); return; }
    list.forEach(function(r){
      host.appendChild(el("a",{class:"report-item","href":"/reports/"+encodeURIComponent(r.id),"data-nav":"/reports/"+encodeURIComponent(r.id)},[
        el("h3",null,[r.title || r.category || "Report"]),
        el("div",{class:"report-meta"},[(r.city||"")+(r.state?", "+r.state:"")+" · "+fmtTime(r.created_at)]),
        el("p",null,[String(r.activity||"").slice(0,260)])
      ]));
    });
  }).catch(function(e){ host.innerHTML = ""; host.appendChild(el("p",{class:"error"},["Could not load: "+e.message])); });
}

function renderReportDetail(root, params){
  var host = el("div",{class:"wrap"},[el("p",{class:"muted"},["Loading report…"])]);
  root.appendChild(host);
  api("/api/reports/"+encodeURIComponent(params.id)).then(function(r){
    r = r.report || r;
    host.innerHTML = "";
    host.appendChild(el("a",{"href":"/reports","data-nav":"/reports"},["← All reports"]));
    host.appendChild(el("h1",null,[r.title || r.category || "Report"]));
    host.appendChild(el("div",{class:"report-meta"},[(r.city||"")+(r.state?", "+r.state:"")+" · "+fmtTime(r.created_at)]));
    host.appendChild(el("div",{class:"card"},[
      el("p",null,[r.activity||""]),
      r.officials ? el("p",null,[el("strong",null,["Officials: "]), r.officials]) : null,
      r.vehicles ? el("p",null,[el("strong",null,["Vehicles: "]), r.vehicles]) : null
    ].filter(Boolean)));
    if (r.lat && r.lon){
      host.appendChild(el("div",{id:"rmap",style:"height:320px;border:1px solid var(--line);border-radius:10px;margin-top:1rem"}));
      setTimeout(function(){
        if (typeof L === "undefined") return;
        var m = L.map("rmap").setView([r.lat,r.lon], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"&copy; OpenStreetMap"}).addTo(m);
        L.circleMarker([r.lat,r.lon],{radius:9,color:"#c8102e",fillColor:"#c8102e",fillOpacity:0.85}).addTo(m);
      },50);
    }
  }).catch(function(e){ host.innerHTML = ""; host.appendChild(el("p",{class:"error"},["Could not load report: "+e.message])); });
}

function renderReport(root){
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Submit a report"]),
    el("p",{class:"muted"},["Anonymous. No account. Photos have location metadata stripped automatically."]),
    el("form",{id:"rform",class:"card"},[
      el("label",{"for":"category"},["Type of activity"]),
      el("select",{id:"category",name:"category",required:"required"},
        [el("option",{value:""},["Select…"])].concat(CATEGORIES.map(function(c){ return el("option",{value:c[0]},[c[1]]); }))
      ),
      el("label",{"for":"title"},["Short headline (optional)"]),
      el("input",{type:"text",id:"title",name:"title",maxlength:"120",placeholder:"e.g., Checkpoint at 5th & Main"}),
      el("label",{"for":"activity"},["What happened *"]),
      el("textarea",{id:"activity",name:"activity",required:"required",maxlength:"4000",placeholder:"Describe what you saw. Do not include your name or identifying info."}),
      el("div",{class:"grid cols-2"},[
        el("div",null,[el("label",{"for":"city"},["City"]),el("input",{type:"text",id:"city",name:"city",maxlength:"80"})]),
        el("div",null,[el("label",{"for":"state"},["State"]),el("input",{type:"text",id:"state",name:"state",maxlength:"2",placeholder:"CA"})])
      ]),
      el("div",{class:"grid cols-2"},[
        el("div",null,[el("label",{"for":"lat"},["Latitude (optional)"]),el("input",{type:"text",id:"lat",name:"lat",placeholder:"Use my location"})]),
        el("div",null,[el("label",{"for":"lon"},["Longitude (optional)"]),el("input",{type:"text",id:"lon",name:"lon"})])
      ]),
      el("button",{type:"button",class:"btn small ghost",onclick:grabLocation},["📍 Use my approximate location"]),
      el("label",{"for":"officials"},["Officials observed (optional)"]),
      el("input",{type:"text",id:"officials",name:"officials",maxlength:"200",placeholder:"Agency names, uniforms, badges"}),
      el("label",{"for":"vehicles"},["Vehicles observed (optional)"]),
      el("input",{type:"text",id:"vehicles",name:"vehicles",maxlength:"200",placeholder:"Make, model, color, plate prefix"}),
      el("label",{"for":"photo"},["Photo (optional, EXIF stripped)"]),
      el("input",{type:"file",id:"photo",name:"photo",accept:"image/*"}),
      el("div",{id:"ts-host",style:"margin-top:1rem"}),
      el("p",{id:"rform-msg"}),
      el("button",{type:"submit",class:"btn"},["Submit anonymously"])
    ])
  ]));
  mountTurnstile("#ts-host");
  $("#rform").addEventListener("submit", submitReport);
}

function grabLocation(){
  if (!navigator.geolocation) return toast("Location not supported");
  navigator.geolocation.getCurrentPosition(function(pos){
    $("#lat").value = pos.coords.latitude.toFixed(5);
    $("#lon").value = pos.coords.longitude.toFixed(5);
    toast("Location filled");
  }, function(){ toast("Could not get location"); }, {timeout:8000,maximumAge:60000});
}

function submitReport(ev){
  ev.preventDefault();
  var form = ev.target;
  var msg = $("#rform-msg"); msg.textContent = ""; msg.className = "";
  var data = {
    category: form.category.value,
    title: form.title.value.trim() || null,
    activity: form.activity.value.trim(),
    city: form.city.value.trim() || null,
    state: (form.state.value||"").toUpperCase().trim() || null,
    lat: form.lat.value ? parseFloat(form.lat.value) : null,
    lon: form.lon.value ? parseFloat(form.lon.value) : null,
    officials: form.officials.value.trim() || null,
    vehicles: form.vehicles.value.trim() || null,
    turnstile_token: getTurnstileToken()
  };
  if (!data.category || !data.activity){ msg.textContent = "Please fill in the required fields."; msg.className="error"; return; }
  var btn = form.querySelector("button[type=submit]"); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Submitting…';
  var photoFile = form.photo.files && form.photo.files[0];
  var upload = photoFile ? uploadPhoto(photoFile) : Promise.resolve(null);
  upload.then(function(mediaId){
    if (mediaId) data.media_ids = [mediaId];
    return api("/api/reports",{method:"POST",body:data});
  }).then(function(res){
    analytics.track("report_submitted",{category:data.category});
    msg.className="ok"; msg.textContent = "Thank you. Your report is pending moderation and will appear on the map once approved.";
    form.reset();
    setTimeout(function(){ navigate("/"); }, 2000);
  }).catch(function(e){
    msg.className="error"; msg.textContent = "Could not submit: "+e.message;
  }).then(function(){ btn.disabled=false; btn.textContent="Submit anonymously"; });
}

function uploadPhoto(file){
  return api("/api/upload/sign",{method:"POST",body:{content_type:file.type,size:file.size}}).then(function(sig){
    if (sig.upload_url){
      return fetch(sig.upload_url,{method:"PUT",headers:{"Content-Type":file.type},body:file})
        .then(function(r){ if (!r.ok) throw new Error("Upload failed"); return sig.media_id || sig.id; });
    }
    // fallback: direct post
    var fd = new FormData(); fd.append("file", file);
    return api("/api/upload",{method:"POST",body:fd}).then(function(r){ return r.media_id || r.id; });
  });
}

function mountTurnstile(host){
  var h = $(host); if (!h) return;
  if (!TURNSTILE_SITE_KEY || TURNSTILE_SITE_KEY.indexOf("1x000000") === 0){
    // test/dev key or not configured — show stub
    h.innerHTML = '<input type="hidden" id="cf-ts-token" value="dev-bypass" /><p class=help>Security check: dev mode</p>';
    return;
  }
  if (!window._tsLoaded){
    window._tsLoaded = true;
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true;
    document.head.appendChild(s);
  }
  h.innerHTML = '<div id="cf-ts"></div><input type="hidden" id="cf-ts-token" />';
  var tryRender = function(){
    if (!window.turnstile) return setTimeout(tryRender, 200);
    window.turnstile.render("#cf-ts",{sitekey:TURNSTILE_SITE_KEY, callback:function(tok){ var i=$("#cf-ts-token"); if(i) i.value=tok; }});
  };
  tryRender();
}
function getTurnstileToken(){ var i = $("#cf-ts-token"); return i ? i.value : ""; }

function renderSubscribe(root){
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Get email alerts"]),
    el("p",{class:"muted"},["Choose a zip code and radius. We'll send you an alert when an approved report lands in your area, plus an optional daily digest."]),
    el("form",{id:"subform",class:"card"},[
      el("label",{"for":"email"},["Email *"]),
      el("input",{type:"email",id:"email",name:"email",required:"required"}),
      el("div",{class:"grid cols-2"},[
        el("div",null,[el("label",{"for":"zip"},["ZIP code *"]),el("input",{type:"text",id:"zip",name:"zip",required:"required",maxlength:"10",pattern:"[0-9]{5}"})]),
        el("div",null,[el("label",{"for":"radius"},["Radius (miles)"]),el("input",{type:"number",id:"radius",name:"radius",min:"1",max:"250",value:"50"})])
      ]),
      el("label",null,[el("input",{type:"checkbox",id:"digest",name:"digest",checked:"checked"}), " Daily AlertIQ digest (9am local)"]),
      el("p",{id:"sub-msg"}),
      el("button",{type:"submit",class:"btn"},["Subscribe"])
    ]),
    el("p",{class:"help",style:"margin-top:.75rem"},["We only use your email to send alerts. Unsubscribe any time with one click."])
  ]));
  $("#subform").addEventListener("submit", function(ev){
    ev.preventDefault();
    var msg = $("#sub-msg"); msg.textContent=""; msg.className="";
    var body = {
      email: $("#email").value.trim(),
      zip: $("#zip").value.trim(),
      radius_mi: parseInt($("#radius").value||"50",10),
      digest_enabled: $("#digest").checked ? 1 : 0
    };
    api("/api/subscribe",{method:"POST",body:body}).then(function(){
      msg.className="ok"; msg.textContent = "Check your inbox to confirm your subscription.";
      analytics.track("subscribe_submitted");
    }).catch(function(e){ msg.className="error"; msg.textContent = "Could not subscribe: "+e.message; });
  });
}

function renderVolunteer(root){
  var s = getSession();
  if (s && s.token) return renderVolunteerHome(root, s);
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Volunteer login"]),
    el("p",{class:"muted"},["Volunteers moderate reports. Anyone can submit a report without an account."]),
    el("form",{id:"loginform",class:"card"},[
      el("label",{"for":"lemail"},["Email"]),
      el("input",{type:"email",id:"lemail",required:"required"}),
      el("label",{"for":"lpw"},["Password"]),
      el("input",{type:"password",id:"lpw",required:"required"}),
      el("p",{id:"login-msg"}),
      el("button",{type:"submit",class:"btn"},["Request one-time code"])
    ]),
    el("div",{id:"otp-card",style:"display:none",class:"card"},[
      el("label",{"for":"otp"},["Enter the 6-digit code emailed to you"]),
      el("input",{type:"text",id:"otp",maxlength:"6",inputmode:"numeric"}),
      el("p",{id:"otp-msg"}),
      el("button",{type:"button",class:"btn",onclick:verifyOtp},["Verify"])
    ])
  ]));
  $("#loginform").addEventListener("submit", doLogin);
}

function doLogin(ev){
  ev.preventDefault();
  var msg = $("#login-msg"); msg.textContent=""; msg.className="";
  var body = {email: $("#lemail").value.trim(), password: $("#lpw").value};
  api("/api/vol/login",{method:"POST",body:body}).then(function(res){
    msg.className="ok"; msg.textContent = "Code sent. Check your email.";
    $("#otp-card").style.display = "block";
    if (res._dev_code){ $("#otp").value = res._dev_code; toast("Dev mode: code pre-filled"); }
    window._pendingLoginEmail = body.email;
  }).catch(function(e){ msg.className="error"; msg.textContent = e.message; });
}

function verifyOtp(){
  var msg = $("#otp-msg"); msg.textContent=""; msg.className="";
  api("/api/vol/verify-otp",{method:"POST",body:{email:window._pendingLoginEmail, code: $("#otp").value.trim()}})
    .then(function(res){
      setSession({token: res.session_token, volunteer: res.volunteer, expires_at: res.expires_at});
      toast("Signed in");
      render();
    }).catch(function(e){ msg.className="error"; msg.textContent = e.message; });
}

function renderVolunteerHome(root, s){
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Volunteer console"]),
    el("p",{class:"muted"},["Signed in as "+(s.volunteer && s.volunteer.email||"")+" — role: "+(s.volunteer && s.volunteer.role||"volunteer")]),
    el("div",{class:"btn-row"},[
      el("a",{class:"btn","href":"/admin","data-nav":"/admin"},["Moderation queue"]),
      el("button",{class:"btn ghost",onclick:function(){ api("/api/vol/logout",{method:"POST"}).finally(function(){ setSession(null); navigate("/"); }); }},["Sign out"])
    ])
  ]));
}

function renderAdmin(root){
  var s = getSession();
  if (!s || !s.token){ navigate("/volunteer", true); return; }
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Moderation queue"]),
    el("div",{class:"filters"},[
      el("select",{id:"modstate",onchange:loadMod},[
        el("option",{value:"pending",selected:"selected"},["Pending"]),
        el("option",{value:"approved"},["Approved"]),
        el("option",{value:"rejected"},["Rejected"])
      ])
    ]),
    el("div",{id:"mod-list",class:"report-list"},[el("p",{class:"muted"},["Loading…"])])
  ]));
  loadMod();
}

function loadMod(){
  var state = $("#modstate") ? $("#modstate").value : "pending";
  var host = $("#mod-list"); host.innerHTML = "<p class=muted>Loading…</p>";
  api("/api/reports?status="+encodeURIComponent(state)+"&limit=100&moderation=1").then(function(res){
    var list = res.reports || res.items || [];
    host.innerHTML = "";
    if (!list.length) return host.appendChild(el("p",{class:"muted"},["Queue empty."]));
    list.forEach(function(r){
      var item = el("div",{class:"report-item"},[
        el("h3",null,[r.title || r.category || "Report"]),
        el("div",{class:"report-meta"},[(r.city||"")+(r.state?", "+r.state:"")+" · "+fmtTime(r.created_at)+" · "+esc(r.category||"")]),
        el("p",null,[r.activity||""]),
        el("div",{class:"btn-row"},[
          el("button",{class:"btn small",onclick:function(){ modAction(r.id,"approve"); }},["Approve"]),
          el("button",{class:"btn small ghost",onclick:function(){ modAction(r.id,"reject"); }},["Reject"]),
          el("button",{class:"btn small ghost",onclick:function(){ modAction(r.id,"pin"); }},["Pin 24h"]),
          el("button",{class:"btn small ghost",onclick:function(){ modAction(r.id,"hide"); }},["Hide"])
        ])
      ]);
      host.appendChild(item);
    });
  }).catch(function(e){ host.innerHTML=""; host.appendChild(el("p",{class:"error"},["Load failed: "+e.message])); });
}

function modAction(id, action){
  api("/api/admin/reports/"+encodeURIComponent(id)+"/"+action,{method:"POST",body:{}}).then(function(){
    toast("Done: "+action); loadMod();
  }).catch(function(e){ toast("Failed: "+e.message); });
}

function renderAbout(root){
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["About OurALERT"]),
    el("p",null,["OurALERT is a community-run, non-commercial platform for reporting ICE and military enforcement activity. Our goal is to protect vulnerable communities by making it easier to share verified, time-sensitive information about enforcement operations."]),
    el("h2",null,["How reporting works"]),
    el("p",null,["Anyone can submit a report. No account is required. Reports go through a moderation queue before they appear on the public map. Approved reports stay prominent for 24 hours before moving to the historical archive."]),
    el("h2",null,["Privacy"]),
    el("p",null,["We do not use third-party analytics or advertising trackers. Photos have location metadata (EXIF) stripped server-side before storage. Reporter IP addresses are hashed and retained only long enough to enforce rate limits. See our ",el("a",{"href":"/privacy","data-nav":"/privacy"},["privacy policy"]),"."]),
    el("h2",null,["Volunteer"]),
    el("p",null,["Volunteers moderate reports, verify facilities, and respond to reports of platform abuse. ",el("a",{"href":"/volunteer","data-nav":"/volunteer"},["Sign in"])," or email us at volunteer@ouralert.org."])
  ]));
}

function renderPrivacy(root){
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Privacy policy"]),
    el("p",{class:"muted"},["Last updated: April 2026"]),
    el("h2",null,["What we collect"]),
    el("p",null,["From anonymous reporters: the content of your report, an optional photo (with location metadata stripped before storage), and a one-way hash of your IP address used for rate limiting. We do not store your IP in plaintext."]),
    el("p",null,["From subscribers: your email, ZIP code, alert radius, and delivery preferences."]),
    el("p",null,["From volunteers: your email, a password hash (PBKDF2), and actions you take in the moderation queue."]),
    el("h2",null,["What we do not collect"]),
    el("p",null,["We do not use third-party analytics, advertising trackers, or session replay. We do not sell or share data with any third party. We do not cooperate with enforcement requests for data beyond what is legally required — see our ",el("a",{"href":"/security","data-nav":"/security"},["security page"])," for our canary."]),
    el("h2",null,["Retention"]),
    el("p",null,["Hashed IPs are deleted after 7 days. Analytics events are deleted after 30 days. Rejected reports are deleted after 14 days. You may unsubscribe any time via the link in alert emails — unsubscribe hard-deletes your subscriber row immediately."])
  ]));
}

function renderTerms(root){
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Terms of use"]),
    el("p",null,["OurALERT is provided free of charge, as-is, with no warranty. By submitting a report you affirm that the information is truthful to the best of your knowledge and does not identify private individuals (including the reporter) except public officials acting in their official capacity."]),
    el("p",null,["Do not submit reports that you did not personally witness or that contain information you obtained illegally. Do not use OurALERT to harass individuals. Do not attempt to disrupt the platform."]),
    el("p",null,["We reserve the right to reject, hide, or remove any report at our discretion, particularly those that include personal information of private individuals, appear to be coordinated disinformation, or violate applicable law."])
  ]));
}

function renderSecurity(root){
  root.appendChild(el("div",{class:"wrap"},[
    el("h1",null,["Security & warrant canary"]),
    el("h2",null,["Our commitments"]),
    el("ul",null,[
      el("li",null,["Photos are EXIF-stripped server-side before storage."]),
      el("li",null,["IP addresses are hashed with a rotating secret before storage."]),
      el("li",null,["All pages are served over HTTPS with HSTS."]),
      el("li",null,["No third-party analytics or trackers."]),
      el("li",null,["Session tokens expire after 12 hours."])
    ]),
    el("h2",null,["Warrant canary"]),
    el("p",null,["As of the last update to this page, OurALERT has not received any national security letters, gag orders, or warrants for user data. This statement will be removed if that changes."]),
    el("p",{class:"muted"},["Last confirmed: April 14, 2026"])
  ]));
}

function renderNotFound(root){
  root.appendChild(el("div",{class:"wrap center",style:"padding:3rem 1rem"},[
    el("h1",null,["Page not found"]),
    el("p",null,[el("a",{class:"btn","href":"/","data-nav":"/"},["Go home"])])
  ]));
}

// ---- routes ----
register("/", renderHome);
register("/reports", renderReports);
register("/report", renderReport);
register("/subscribe", renderSubscribe);
register("/volunteer", renderVolunteer);
register("/admin", renderAdmin);
register("/about", renderAbout);
register("/privacy", renderPrivacy);
register("/terms", renderTerms);
register("/security", renderSecurity);

// ---- boot ----
(function boot(){
  var y = document.getElementById("yr"); if (y) y.textContent = new Date().getFullYear();
  // pull public config (site key) from backend; fall back to placeholder
  api("/api/config").then(function(c){ if (c && c.turnstile_site_key) TURNSTILE_SITE_KEY = c.turnstile_site_key; }).catch(function(){});
  render();
})();

})();
