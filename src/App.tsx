import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { SettingsBootstrap } from "@/components/SettingsBootstrap";
import { UiThemeSync } from "@/components/UiThemeSync";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import Login from "./pages/Login";
import AdminPage from "./pages/AdminPage";

const queryClient = new QueryClient();

function AppRoutes() {
  const { ready, serverAvailable, user } = useAuth();

  if (!ready) {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  // API up but not signed in: force login for team server mode.
  if (serverAvailable && !user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // API down or already signed in: main app; /login stays available when API is down so you can open the sign-in page.
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/admin" element={user ? <AdminPage /> : <Navigate to="/" replace />} />
      <Route path="/" element={<Index />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="evigstudio-theme">
      <TooltipProvider>
        <Sonner />
        <BrowserRouter>
          <AuthProvider>
            <SettingsBootstrap />
            <UiThemeSync />
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
