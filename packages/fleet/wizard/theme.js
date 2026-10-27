/* Shared portable appearance control: no framework or network dependency. */
(function () {
  var key = 'workspace-admin-color-scheme';
  var preference = 'auto';
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  function valid(value) {
    return value === 'light' || value === 'dark' || value === 'auto';
  }
  try {
    var saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch (error) {
    /* Optional preference. */
  }
  function apply() {
    document.documentElement.setAttribute(
      'data-mantine-color-scheme',
      preference === 'auto' ? (media.matches ? 'dark' : 'light') : preference
    );
    var select = document.getElementById('admin-theme');
    if (select) select.value = preference;
  }
  apply();
  media.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    var select = document.getElementById('admin-theme');
    if (select)
      select.addEventListener('change', function () {
        preference = select.value;
        try {
          localStorage.setItem(key, preference);
        } catch (error) {
          /* Optional preference. */
        }
        apply();
      });
  });
  window.addEventListener('storage', function (event) {
    if (event.key === key) {
      preference = valid(event.newValue) ? event.newValue : 'auto';
      apply();
    }
  });
})();
