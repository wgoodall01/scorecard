import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/App";

export const Route = createFileRoute("/")({ component: HomePage });
