import Vapi from "@vapi-ai/web";
import { clientEnv } from "@/env/client";

// Initialize Vapi instance with public key
export const vapi = new Vapi(clientEnv.NEXT_PUBLIC_VAPI_PUBLIC_KEY);
