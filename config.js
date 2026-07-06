// ─────────────────────────────────────────────────────────────────────────────
// OnDemand HQ digital twin — runtime config
// Edit this file only. No build step required.
// ─────────────────────────────────────────────────────────────────────────────
window.OHQ_CONFIG = {
  // Your H100 OptiX render endpoint. Powers the green "Photoreal render (H100)"
  // button — it POSTs the current camera to <renderEndpoint>/api/render and shows
  // the GPU render. The walkthrough works fully WITHOUT this; leave it "" to hide
  // the button.
  //
  // NOTE: the free trycloudflare URL is EPHEMERAL — it changes whenever the tunnel
  // restarts on the H100 node. Re-run /root/ohq/deploy/launch.sh there and copy the
  // new value from /root/ohq/PUBLIC_URL.txt into the line below.
  renderEndpoint: "https://contained-yards-propecia-announced.trycloudflare.com"
};
