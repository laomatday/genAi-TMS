(function applySavedTheme() {
  try {
    const savedTheme = localStorage.getItem('genai_theme');
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', savedTheme === 'dark' || (!savedTheme && systemDark));
  } catch {
    // Storage access can be disabled; the CSS light theme remains the safe default.
  }
})();
