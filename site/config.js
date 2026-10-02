/* Supabase connection for Watchlist and Journal.
   Both values are meant to be public: the database only lets each signed-in person
   see their own rows (see supabase/schema.sql). Never put the service_role key here. */
window.STAGE_CFG = {
  supabaseUrl: "",
  supabaseKey: "",
};
