// Supabase connection for the deployed site. The GitHub deploy workflow
// overwrites this file using the repository variables SUPABASE_URL and
// SUPABASE_ANON_KEY. Left empty, the app opens in demo mode.
window.BRANDIGADE_CONFIG = window.BRANDIGADE_CONFIG || {
  supabaseUrl: "",
  supabaseAnonKey: "",
};
