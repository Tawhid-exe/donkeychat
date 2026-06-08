import { useState, useEffect } from 'react';
import { initIdentity, getOS } from '../core/identity';

export function useIdentity() {
  const [identity, setIdentity] = useState(null);

  useEffect(() => {
    initIdentity().then(id => setIdentity({ ...id, os: getOS() }));
  }, []);

  return identity;
}
