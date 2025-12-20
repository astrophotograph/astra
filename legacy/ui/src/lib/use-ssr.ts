import {useEffect, useState} from 'react'

export const useIsSsr = () => {
  const [isSsr, setIsSsr] = useState(true);

  // `useEffect` never runs on the server, so we must be on the client if
  // we hit this block
  useEffect(() => setIsSsr(false), []);

  return isSsr;
};
