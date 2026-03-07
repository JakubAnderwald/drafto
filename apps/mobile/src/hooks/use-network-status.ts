import { useState, useEffect, useCallback } from "react";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";

interface NetworkStatus {
  isConnected: boolean;
  isInternetReachable: boolean | null;
}

export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>({
    isConnected: true,
    isInternetReachable: null,
  });

  const handleStateChange = useCallback((state: NetInfoState) => {
    setStatus({
      isConnected: state.isConnected ?? false,
      isInternetReachable: state.isInternetReachable,
    });
  }, []);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(handleStateChange);
    return () => unsubscribe();
  }, [handleStateChange]);

  return status;
}
