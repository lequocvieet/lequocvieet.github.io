if ('serviceWorker' in navigator) {
  // Get Jekyll config from URL parameters
  const src = new URL(document.currentScript.src);
  // Jekyll may pass register=false; only the string "true" should enable SW.
  const register = src.searchParams.get('register') === 'true';
  const baseUrl = src.searchParams.get('baseurl');

  if (register) {
    const swUrl = `${baseUrl}/sw.min.js`;

    const activateWaiting = (registration) => {
      if (registration.waiting) {
        registration.waiting.postMessage('SKIP_WAITING');
      }
    };

    navigator.serviceWorker.register(swUrl).then((registration) => {
      // Auto-apply waiting worker instead of showing an Update toast
      activateWaiting(registration);

      registration.addEventListener('updatefound', () => {
        registration.installing.addEventListener('statechange', () => {
          if (registration.waiting && navigator.serviceWorker.controller) {
            activateWaiting(registration);
          }
        });
      });
    });

    let refreshing = false;

    // Detect controller change and refresh all the opened tabs
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        window.location.reload();
        refreshing = true;
      }
    });
  } else {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      for (let registration of registrations) {
        registration.unregister();
      }
    });
  }
}
