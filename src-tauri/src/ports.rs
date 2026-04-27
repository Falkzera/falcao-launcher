use std::net::TcpListener;

pub fn is_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn find_free_port(preferred: Option<u16>) -> Option<u16> {
    if let Some(port) = preferred {
        if port >= 1024 && is_port_free(port) {
            return Some(port);
        }
        for offset in 1..=100u16 {
            let candidate = port.checked_add(offset)?;
            if is_port_free(candidate) {
                return Some(candidate);
            }
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn find_free_returns_preferred_when_available() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(find_free_port(Some(port)), Some(port));
    }

    #[test]
    fn find_free_increments_when_preferred_busy() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = listener.local_addr().unwrap().port();
        let result = find_free_port(Some(busy));
        assert!(result.is_some());
        assert_ne!(result, Some(busy));
    }

    #[test]
    fn find_free_falls_back_when_no_preference() {
        let result = find_free_port(None);
        assert!(result.is_some());
        assert!(result.unwrap() >= 1024);
    }
}
