import type {
  BundlerState,
  ListenerFunction,
  ReactDevToolsMode,
  SandpackError,
  SandpackMessage,
  UnsubscribeFunction,
  SandpackClient,
} from "@codesandbox/sandpack-client";
import {
  loadSandpackClient,
  extractErrorDetails,
} from "@codesandbox/sandpack-client";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  SandpackInitMode,
  SandpackProviderProps,
  SandpackStatus,
} from "../..";
import { generateRandomId } from "../../utils/stringUtils";

import type { FilesState } from "./useFiles";
type SandpackClientType = InstanceType<typeof SandpackClient>;

const BUNDLER_TIMEOUT = 30000; // 30 seconds timeout for the bundler to respond.

interface SandpackConfigState {
  reactDevTools?: ReactDevToolsMode;
  startRoute?: string;
  initMode: SandpackInitMode;
  bundlerState: BundlerState | undefined;
  error: SandpackError | null;
  status: SandpackStatus;
}

export interface UseClientOperations {
  clients: Record<string, SandpackClientType>;
  initializeSandpackIframe: () => void;
  runSandpack: () => Promise<void>;
  unregisterBundler: (clientId: string) => void;
  registerBundler: (
    iframe: HTMLIFrameElement,
    clientId: string
  ) => Promise<void>;
  registerReactDevTools: (value: ReactDevToolsMode) => void;
  addListener: (
    listener: ListenerFunction,
    clientId?: string
  ) => UnsubscribeFunction;
  dispatchMessage: (message: SandpackMessage, clientId?: string) => void;
  lazyAnchorRef: React.RefObject<HTMLDivElement>;
  loadingScreenRegisteredRef: React.MutableRefObject<boolean>;
  errorScreenRegisteredRef: React.MutableRefObject<boolean>;
  unsubscribeClientListenersRef: React.MutableRefObject<
    Record<string, Record<string, UnsubscribeFunction>>
  >;
  queuedListenersRef: React.MutableRefObject<
    Record<string, Record<string, ListenerFunction>>
  >;
}

type UseClient = (
  props: SandpackProviderProps,
  filesState: FilesState
) => [SandpackConfigState, UseClientOperations];

export const useClient: UseClient = (props, filesState) => {
  const initModeFromProps = props.options?.initMode || "lazy";

  const [state, setState] = useState<SandpackConfigState>({
    startRoute: props.options?.startRoute,
    bundlerState: undefined,
    error: null,
    initMode: initModeFromProps,
    reactDevTools: undefined,
    status: props.options?.autorun ?? true ? "initial" : "idle",
  });

  /**
   * Refs
   */
  const intersectionObserver = useRef<IntersectionObserver | null>(null);
  const lazyAnchorRef = useRef<HTMLDivElement>(null);
  const initializeSandpackIframeHook = useRef<NodeJS.Timer | null>(null);
  const preregisteredIframes = useRef<Record<string, HTMLIFrameElement>>({});
  const clients = useRef<Record<string, SandpackClientType>>({});
  const timeoutHook = useRef<NodeJS.Timer | null>(null);
  const unsubscribeClientListeners = useRef<
    Record<string, Record<string, UnsubscribeFunction>>
  >({});
  const unsubscribe = useRef<() => void | undefined>();
  const queuedListeners = useRef<
    Record<string, Record<string, ListenerFunction>>
  >({ global: {} });
  const debounceHook = useRef<number | undefined>();
  const loadingScreenRegisteredRef = useRef<boolean>(true);
  const errorScreenRegisteredRef = useRef<boolean>(true);
  const prevEnvironment = useRef(filesState.environment);

  /**
   * Callbacks
   */
  const createClient = useCallback(
    async (
      iframe: HTMLIFrameElement,
      clientId: string
    ): Promise<SandpackClientType> => {
      const timeOut = props.options?.bundlerTimeOut ?? BUNDLER_TIMEOUT;

      if (timeoutHook.current) {
        clearTimeout(timeoutHook.current);
      }

      timeoutHook.current = setTimeout(() => {
        setState((prev) => ({ ...prev, status: "timeout" }));
      }, timeOut);

      const client = await loadSandpackClient(
        iframe,
        {
          files: filesState.files,
          template: filesState.environment,
        },
        {
          externalResources: props.options?.externalResources,
          bundlerURL: props.options?.bundlerURL,
          startRoute: props.options?.startRoute,
          fileResolver: props.options?.fileResolver,
          skipEval: props.options?.skipEval ?? false,
          logLevel: props.options?.logLevel,
          showOpenInCodeSandbox: false,
          showErrorScreen: errorScreenRegisteredRef.current,
          showLoadingScreen: loadingScreenRegisteredRef.current,
          reactDevTools: state.reactDevTools,
          customNpmRegistries: props.customSetup?.npmRegistries?.map(
            (config) =>
              ({
                ...config,
                proxyEnabled: false, // force
              } ?? [])
          ),
        }
      );

      /**
       * Subscribe inside the context with the first client that gets instantiated.
       * This subscription is for global states like error and timeout, so no need for a per client listen
       * Also, set the timeout timer only when the first client is instantiated
       */
      if (typeof unsubscribe.current !== "function") {
        unsubscribe.current = client.listen(handleMessage);
      }

      unsubscribeClientListeners.current[clientId] =
        unsubscribeClientListeners.current[clientId] || {};

      /**
       * Register any potential listeners that subscribed before sandpack ran
       */
      if (queuedListeners.current[clientId]) {
        Object.keys(queuedListeners.current[clientId]).forEach((listenerId) => {
          const listener = queuedListeners.current[clientId][listenerId];
          const unsubscribe = client.listen(listener) as () => void;
          unsubscribeClientListeners.current[clientId][listenerId] =
            unsubscribe;
        });

        // Clear the queued listeners after they were registered
        queuedListeners.current[clientId] = {};
      }

      /**
       * Register global listeners
       */
      const globalListeners = Object.entries(queuedListeners.current.global);
      globalListeners.forEach(([listenerId, listener]) => {
        const unsubscribe = client.listen(listener) as () => void;
        unsubscribeClientListeners.current[clientId][listenerId] = unsubscribe;

        /**
         * Important: Do not clean the global queue
         * Instead of cleaning the queue, keep it there for the
         * following clients that might be created
         */
      });

      return client;
    },
    [
      filesState.environment,
      filesState.files,
      props.customSetup?.npmRegistries,
      props.options?.bundlerURL,
      props.options?.externalResources,
      props.options?.fileResolver,
      props.options?.logLevel,
      props.options?.skipEval,
      props.options?.startRoute,
      state.reactDevTools,
    ]
  );

  const unregisterAllClients = useCallback((): void => {
    Object.keys(clients.current).map(unregisterBundler);

    if (typeof unsubscribe.current === "function") {
      unsubscribe.current();
      unsubscribe.current = undefined;
    }
  }, []);

  const runSandpack = useCallback(async (): Promise<void> => {
    await Promise.all(
      Object.keys(preregisteredIframes.current).map(async (clientId) => {
        const iframe = preregisteredIframes.current[clientId];
        clients.current[clientId] = await createClient(iframe, clientId);
      })
    );

    setState((prev) => ({ ...prev, status: "running" }));
  }, [createClient]);

  const initializeSandpackIframe = useCallback((): void => {
    const autorun = props.options?.autorun ?? true;

    if (!autorun) {
      return;
    }

    const observerOptions = props.options?.initModeObserverOptions ?? {
      rootMargin: `1000px 0px`,
    };

    if (intersectionObserver.current && lazyAnchorRef.current) {
      intersectionObserver.current?.unobserve(lazyAnchorRef.current);
    }

    if (lazyAnchorRef.current && state.initMode === "lazy") {
      // If any component registerd a lazy anchor ref component, use that for the intersection observer
      intersectionObserver.current = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          // Delay a cycle so all hooks register the refs for the sub-components (open in csb, loading, error overlay)
          initializeSandpackIframeHook.current = setTimeout(() => {
            runSandpack();
          }, 50);

          if (lazyAnchorRef.current) {
            intersectionObserver.current?.unobserve(lazyAnchorRef.current);
          }
        }
      }, observerOptions);

      intersectionObserver.current.observe(lazyAnchorRef.current);
    } else if (lazyAnchorRef.current && state.initMode === "user-visible") {
      intersectionObserver.current = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          // Delay a cycle so all hooks register the refs for the sub-components (open in csb, loading, error overlay)
          initializeSandpackIframeHook.current = setTimeout(() => {
            runSandpack();
          }, 50);
        } else {
          if (initializeSandpackIframeHook.current) {
            clearTimeout(initializeSandpackIframeHook.current);
          }

          Object.keys(clients.current).map(unregisterBundler);
          unregisterAllClients();
        }
      }, observerOptions);

      intersectionObserver.current.observe(lazyAnchorRef.current);
    } else {
      // else run the sandpack on mount, with a slight delay to allow all subcomponents to mount/register components
      initializeSandpackIframeHook.current = setTimeout(
        () => runSandpack(),
        50
      );
    }
  }, [
    props.options?.autorun,
    props.options?.initModeObserverOptions,
    runSandpack,
    state.initMode,
    unregisterAllClients,
  ]);

  const registerBundler = async (
    iframe: HTMLIFrameElement,
    clientId: string
  ): Promise<void> => {
    if (state.status === "running") {
      clients.current[clientId] = await createClient(iframe, clientId);
    } else {
      preregisteredIframes.current[clientId] = iframe;
    }
  };

  const unregisterBundler = (clientId: string): void => {
    const client = clients.current[clientId];
    if (client) {
      client.destroy();
      client.iframe.contentWindow?.location.replace("about:blank");
      client.iframe.removeAttribute("src");
      delete clients.current[clientId];
    } else {
      delete preregisteredIframes.current[clientId];
    }

    if (timeoutHook.current) {
      clearTimeout(timeoutHook.current);
    }

    const unsubscribeQueuedClients = Object.values(
      unsubscribeClientListeners.current[clientId]
    );

    // Unsubscribing all listener registered
    unsubscribeQueuedClients.forEach((listenerOfClient) => {
      const listenerFunctions = Object.values(listenerOfClient);
      listenerFunctions.forEach((unsubscribe) => unsubscribe());
    });

    // Keep running if it still have clients
    const status = Object.keys(clients.current).length > 0 ? "running" : "idle";

    setState((prev) => ({ ...prev, status }));
  };

  const handleMessage = (msg: SandpackMessage): void => {
    if (timeoutHook.current) {
      clearTimeout(timeoutHook.current);
    }

    if (msg.type === "state") {
      setState((prev) => ({ ...prev, bundlerState: msg.state }));
    } else if (msg.type === "done" && !msg.compilatonError) {
      setState((prev) => ({ ...prev, error: null }));
    } else if (msg.type === "action" && msg.action === "show-error") {
      setState((prev) => ({ ...prev, error: extractErrorDetails(msg) }));
    } else if (
      msg.type === "action" &&
      msg.action === "notification" &&
      msg.notificationType === "error"
    ) {
      setState((prev) => ({
        ...prev,
        error: { message: msg.title },
      }));
    }
  };

  const registerReactDevTools = (value: ReactDevToolsMode): void => {
    setState((prev) => ({ ...prev, reactDevTools: value }));
  };

  const recompileMode = props.options?.recompileMode ?? "delayed";
  const recompileDelay = props.options?.recompileDelay ?? 500;
  const updateClients = useCallback((): void => {
    if (state.status !== "running" || !filesState.shouldUpdatePreview) {
      return;
    }

    /**
     * When the environment changes, Sandpack needs to make sure
     * to create a new client and the proper bundler
     */
    if (prevEnvironment.current !== filesState.environment) {
      prevEnvironment.current = filesState.environment;

      Object.entries(clients.current).forEach(([key, client]) => {
        registerBundler(client.iframe, key);
      });
    }

    if (recompileMode === "immediate") {
      Object.values(clients.current).forEach((client) => {
        client.updateSandbox({
          files: filesState.files,
          template: filesState.environment,
        });
      });
    }

    if (recompileMode === "delayed") {
      if (typeof window === "undefined") return;

      window.clearTimeout(debounceHook.current);
      debounceHook.current = window.setTimeout(() => {
        Object.values(clients.current).forEach((client) => {
          client.updateSandbox({
            files: filesState.files,
            template: filesState.environment,
          });
        });
      }, recompileDelay);
    }
  }, [
    filesState.shouldUpdatePreview,
    filesState.files,
    filesState.environment,
    recompileMode,
    recompileDelay,
    state.status,
    createClient,
  ]);

  const dispatchMessage = (
    message: SandpackMessage,
    clientId?: string
  ): void => {
    if (state.status !== "running") {
      console.warn(
        `[sandpack-react]: dispatch cannot be called while in idle mode`
      );
      return;
    }

    if (clientId) {
      clients.current[clientId].dispatch(message);
    } else {
      Object.values(clients.current).forEach((client) => {
        client.dispatch(message);
      });
    }
  };

  const addListener = (
    listener: ListenerFunction,
    clientId?: string
  ): UnsubscribeFunction => {
    if (clientId) {
      if (clients.current[clientId]) {
        const unsubscribeListener = clients.current[clientId].listen(listener);

        return unsubscribeListener;
      } else {
        /**
         * When listeners are added before the client is instantiated, they are stored with an unique id
         * When the client is eventually instantiated, the listeners are registered on the spot
         * Their unsubscribe functions are stored in unsubscribeClientListeners for future cleanup
         */
        const listenerId = generateRandomId();
        queuedListeners.current[clientId] =
          queuedListeners.current[clientId] || {};
        unsubscribeClientListeners.current[clientId] =
          unsubscribeClientListeners.current[clientId] || {};

        queuedListeners.current[clientId][listenerId] = listener;

        const unsubscribeListener = (): void => {
          if (queuedListeners.current[clientId][listenerId]) {
            /**
             * Unsubscribe was called before the client was instantiated
             * common example - a component with autorun=false that unmounted
             */
            delete queuedListeners.current[clientId][listenerId];
          } else if (unsubscribeClientListeners.current[clientId][listenerId]) {
            /**
             * unsubscribe was called for a listener that got added before the client was instantiated
             * call the unsubscribe function and remove it from memory
             */
            unsubscribeClientListeners.current[clientId][listenerId]();
            delete unsubscribeClientListeners.current[clientId][listenerId];
          }
        };

        return unsubscribeListener;
      }
    } else {
      // Push to the **global** queue
      const listenerId = generateRandomId();
      queuedListeners.current.global[listenerId] = listener;

      // Add to the current clients
      const clientsList = Object.values(clients.current);
      const currentClientUnsubscribeListeners = clientsList.map((client) =>
        client.listen(listener)
      );

      const unsubscribeListener = (): void => {
        // Unsubscribing from the clients already created
        currentClientUnsubscribeListeners.forEach((unsubscribe) =>
          unsubscribe()
        );

        delete queuedListeners.current.global[listenerId];

        // Unsubscribe in case it was added later from `global`
        Object.values(unsubscribeClientListeners.current).forEach((client) => {
          client?.[listenerId]?.();
        });
      };

      return unsubscribeListener;
    }
  };

  /**
   * Effects
   */
  useEffect(
    function watchFileChanges() {
      updateClients();
    },
    [filesState.files, filesState.environment, updateClients]
  );

  useEffect(
    function watchInitMode() {
      if (initModeFromProps !== state.initMode) {
        setState((prev) => ({ ...prev, initMode: initModeFromProps }));

        initializeSandpackIframe();
      }
    },
    [initModeFromProps, initializeSandpackIframe, state.initMode]
  );

  useEffect(() => {
    return function unmontClient(): void {
      if (typeof unsubscribe.current === "function") {
        unsubscribe.current();
      }

      if (timeoutHook.current) {
        clearTimeout(timeoutHook.current);
      }

      if (debounceHook.current) {
        clearTimeout(debounceHook.current);
      }

      if (initializeSandpackIframeHook.current) {
        clearTimeout(initializeSandpackIframeHook.current);
      }

      if (intersectionObserver.current) {
        intersectionObserver.current.disconnect();
      }
    };
  }, []);

  return [
    state,
    {
      clients: clients.current,
      initializeSandpackIframe,
      runSandpack,
      registerBundler,
      unregisterBundler,
      registerReactDevTools,
      addListener,
      dispatchMessage,
      loadingScreenRegisteredRef,
      errorScreenRegisteredRef,
      lazyAnchorRef,
      unsubscribeClientListenersRef: unsubscribeClientListeners,
      queuedListenersRef: queuedListeners,
    },
  ];
};