// GitHub Pages can't send the header that stops other sites from showing the
// CRM inside a frame (clickjacking), so the page stays hidden in a frame and
// tries to break out of it instead. Loaded first, from <head>.
(function(){
  if(window.top === window.self){
    var guard = document.getElementById("frame-guard");
    if(guard) guard.parentNode.removeChild(guard);
  } else {
    try{ window.top.location = window.self.location.href; }catch(e){ /* stays hidden */ }
  }
})();
