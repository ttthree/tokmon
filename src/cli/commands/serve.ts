import { serve } from "../../server/index.js";

export async function serveCommand(port = 3000): Promise<void> {
  await serve(port);
}
