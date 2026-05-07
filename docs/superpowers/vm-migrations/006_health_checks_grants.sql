-- Princípio do menor privilégio mantido
GRANT INSERT ON health_checks TO monitor_writer;
GRANT SELECT ON health_checks, health_checks_hourly, health_checks_daily TO monitor_reader;
