// Pointer's look (Classic or Sketch) on its own pages. Loaded in <head> so the
// page paints in the right look: the last choice is cached in localStorage,
// then confirmed from the settings in chrome.storage, and followed when it changes.
(() => {
  const KEY = "pointerSettings";
  const apply = (look) => {
    const value = look === "sketch" ? "sketch" : "classic";
    document.documentElement.dataset.look = value;
    try {
      localStorage.setItem("pointerLook", value);
    } catch {}
  };
  try {
    apply(localStorage.getItem("pointerLook"));
  } catch {
    apply("classic");
  }
  chrome.storage?.local.get(KEY).then((v) => apply(v?.[KEY]?.look)).catch(() => {});
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) apply(changes[KEY].newValue?.look);
  });
})();
