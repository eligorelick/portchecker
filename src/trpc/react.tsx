"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchStreamLink, loggerLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { type inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import SuperJSON from "superjson";

import { type AppRouter } from "~/server/api/root";

const createQueryClient = () =>
  new QueryClient({
    // With SSR, we usually want to set some default staleTime above 0 to avoid refetching
    // immediately on the client.
    defaultOptions: { queries: { staleTime: 30 * 1000 } },
  });

let clientQueryClientSingleton: QueryClient | undefined = undefined;
const getQueryClient = () => {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return createQueryClient();
  }
  // Browser: use singleton pattern to keep the same query client
  clientQueryClientSingleton ??= createQueryClient();

  return clientQueryClientSingleton;
};

export const api = createTRPCReact<AppRouter>();

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export function TRPCReactProvider(props: { children: React.ReactNode }) {
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        (runtime) => {
          const log = loggerLink<AppRouter>({
            enabled: (op) =>
              process.env.NODE_ENV === "development" ||
              (op.direction === "down" && op.result instanceof Error),
          })(runtime);
          // Filter the entire operation: down events do not carry the route path.
          return (args) =>
            args.op.path === "settings.save" ? args.next(args.op) : log(args);
        },
        httpBatchStreamLink({
          transformer: SuperJSON,
          url: getBaseUrl() + "/api/trpc",
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {props.children}
      </api.Provider>
    </QueryClientProvider>
  );
}

function getBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
