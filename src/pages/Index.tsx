import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Copy, ExternalLink, Loader2, PlayCircle, RefreshCw } from "lucide-react";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/$/, "");

const Index = () => {
  const [handle, setHandle] = useState("");
  const [limit, setLimit] = useState("5");
  const [theme, setTheme] = useState("dark");
  const [showDate, setShowDate] = useState(true);
  const [showViews, setShowViews] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [cardUrl, setCardUrl] = useState("");
  const [isFallbackCard, setIsFallbackCard] = useState(false);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const buildRequestUrl = (cacheBust?: string) => {
    const endpointBase = API_BASE_URL ? `${API_BASE_URL}/api/youtube-card` : "/api/youtube-card";
    const params = new URLSearchParams();

    params.set("handle", handle.trim());
    if (limit.trim()) params.set("limit", limit.trim());
    params.set("theme", theme);
    params.set("show_date", String(showDate));
    params.set("show_views", String(showViews));
    if (cacheBust) params.set("cache_bust", cacheBust);

    return `${endpointBase}?${params.toString()}`;
  };

  const generateCard = async (forceRefresh = false) => {
    if (!handle.trim()) {
      toast({
        title: "Handle required",
        description: "Please enter a YouTube handle (e.g. @channel).",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    const cacheBust = forceRefresh ? String(Date.now()) : "";
    const requestUrl = buildRequestUrl(cacheBust);

    try {
      const response = await fetch(requestUrl);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to generate card");
      }
      const cardStatus = response.headers.get("X-Card-Status");
      const absoluteUrl = API_BASE_URL
        ? requestUrl
        : `${typeof window !== "undefined" ? window.location.origin : ""}${requestUrl}`;
      setCardUrl(absoluteUrl);
      setIsFallbackCard(cardStatus === "fallback");
      if (cardStatus === "fallback") {
        throw new Error("Failed to generate card. Showing fallback content.");
      }
      toast({
        title: "Success!",
        description: forceRefresh
          ? "Content refreshed with a new cache key."
          : "Your YouTube stats card is ready.",
      });
    } catch (error) {
      setIsFallbackCard(true);
      const message =
        error instanceof Error && error.message.includes("Network error")
          ? "Network error. Please check your internet connection."
          : error instanceof Error && error.message.includes("fallback")
          ? "Failed to generate card. Showing fallback content."
          : "Failed to generate card. Please check the handle.";
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    if (!text) return;

    const copy = async () => {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
    };

    copy();
    setCopied(true);
    toast({
      title: "Copied!",
      description: "Embed code copied to clipboard.",
    });
    setTimeout(() => setCopied(false), 2000);
  };

  const markdownCode = cardUrl ? `![Latest YouTube Videos](${cardUrl})` : "";
  const htmlCode = cardUrl ? `<img src="${cardUrl}" alt="Latest YouTube Videos" />` : "";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_hsl(var(--primary)/0.16),_transparent_55%),linear-gradient(180deg,_hsl(var(--background))_0%,_hsl(var(--background))_55%,_hsl(var(--muted))_100%)]">
      <div className="relative overflow-hidden">
        <div className="absolute -top-20 left-0 h-64 w-64 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute right-0 top-32 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute left-1/2 top-24 h-32 w-32 -translate-x-1/2 rounded-full border border-foreground/10" />

        <header className="relative z-10 border-b border-foreground/10 bg-background/70 backdrop-blur">
          <div className="container mx-auto flex items-center justify-between px-4 py-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_16px_40px_hsl(var(--primary)/0.35)]">
                <PlayCircle className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">YouTube Toolkit</p>
                <h1 className="text-xl font-semibold">YouTube Stats Card</h1>
              </div>
            </div>
            <div className="hidden items-center gap-3 text-xs uppercase tracking-[0.2em] text-muted-foreground md:flex">
              <span className="h-2 w-2 rounded-full bg-primary" />
              Video feed to SVG
            </div>
          </div>
        </header>

        <main className="relative z-10 container mx-auto px-4 pb-16 pt-12">
          <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
            <div className="space-y-6">
              <span className="inline-flex items-center gap-2 rounded-full border border-foreground/10 bg-background/80 px-4 py-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Latest uploads card
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              <h2 className="text-4xl font-semibold leading-tight md:text-5xl">
                Turn your channel feed into a punchy YouTube card.
              </h2>
              <p className="text-lg text-muted-foreground">
                Pull your latest five videos, toggle views and publish dates, and share a
                glossy SVG that is perfect for GitHub, portfolios, and landing pages.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  { label: "01", text: "Enter handle" },
                  { label: "02", text: "Generate SVG" },
                  { label: "03", text: "Share anywhere" },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-2xl border border-foreground/10 bg-card/90 px-4 py-4"
                  >
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      {item.label}
                    </p>
                    <p className="mt-2 text-sm font-semibold">{item.text}</p>
                  </div>
                ))}
              </div>
            </div>

            <Card className="relative overflow-hidden border border-foreground/10 bg-card/90 p-8 shadow-[0_30px_80px_rgba(0,0,0,0.08)]">
              <div className="absolute right-0 top-0 h-1 w-full bg-gradient-to-r from-primary/40 via-primary to-primary/40" />
              <div className="space-y-6">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Input</p>
                  <h3 className="text-xl font-semibold">Configure your card</h3>
                  <p className="text-sm text-muted-foreground">
                    Use a handle (with or without @). Defaults to last 5 uploads.
                  </p>
                </div>

                <div className="grid gap-4">
                  <Input
                    placeholder="YouTube handle (e.g. @shaonmajumder)"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && generateCard()}
                    className="h-12 text-base"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Limit</Label>
                    <Input
                      placeholder="5"
                      value={limit}
                      onChange={(e) => setLimit(e.target.value)}
                      type="number"
                      min="1"
                      max="10"
                      className="h-12 text-base"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Theme</Label>
                    <Select value={theme} onValueChange={setTheme}>
                      <SelectTrigger className="h-12 text-base">
                        <SelectValue placeholder="Select theme" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dark">Studio Dark</SelectItem>
                        <SelectItem value="light">Creator Light</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Generate</Label>
                    <Button
                      onClick={generateCard}
                      disabled={isLoading}
                      size="lg"
                      className="h-12 w-full bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        "Generate Card"
                      )}
                    </Button>
                  </div>
                </div>

                <div className="rounded-2xl border border-foreground/10 bg-background/80 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-6">
                    <div className="flex items-center gap-3">
                      <Switch checked={showDate} onCheckedChange={setShowDate} />
                      <Label>Show date</Label>
                    </div>
                    <div className="flex items-center gap-3">
                      <Switch checked={showViews} onCheckedChange={setShowViews} />
                      <Label>Show views</Label>
                    </div>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">
                  The card uses your server-side API key. Only the public SVG link is shared.
                </p>
              </div>
            </Card>
          </section>

          {cardUrl && (
            <section className="mt-14 space-y-6">
              <Card className="border border-foreground/10 bg-card/90 p-8">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm uppercase tracking-[0.2em] text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-foreground" />
                    Preview
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => generateCard(true)}
                    className="h-8 gap-2"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Refresh content
                  </Button>
                </div>
                <div className="mt-6 rounded-2xl border border-foreground/10 bg-background/80 p-6">
                  <img src={cardUrl} alt="Latest YouTube Videos" className="mx-auto max-w-full" />
                </div>
              </Card>

              {!isFallbackCard && (
                <Card className="border border-foreground/10 bg-card/90 p-8">
                  <h3 className="text-xl font-semibold">Embed Options</h3>

                  <div className="mt-6 space-y-4">
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-muted-foreground">Markdown</label>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(markdownCode)}
                          className="h-8"
                        >
                          {copied ? (
                            <CheckCircle2 className="h-4 w-4 text-foreground" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      <code className="mt-2 block w-full rounded-2xl border border-foreground/10 bg-background/80 p-3 text-sm font-mono break-all">
                        {markdownCode}
                      </code>
                    </div>

                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-muted-foreground">HTML</label>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(htmlCode)}
                          className="h-8"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <code className="mt-2 block w-full rounded-2xl border border-foreground/10 bg-background/80 p-3 text-sm font-mono break-all">
                        {htmlCode}
                      </code>
                    </div>

                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-muted-foreground">Direct URL</label>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyToClipboard(cardUrl)}
                            className="h-8"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" asChild className="h-8">
                            <a href={cardUrl} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </div>
                      </div>
                      <code className="mt-2 block w-full rounded-2xl border border-foreground/10 bg-background/80 p-3 text-sm font-mono break-all">
                        {cardUrl}
                      </code>
                    </div>
                  </div>
                </Card>
              )}
            </section>
          )}

          <section className="mt-14 grid gap-6 md:grid-cols-3">
            {[
              {
                label: "Video feed",
                title: "Always current",
                body: "Shows your latest uploads with live data.",
              },
              {
                label: "Viewer metrics",
                title: "Highlight momentum",
                body: "Toggle view counts for extra proof of traction.",
              },
              {
                label: "Embed-ready",
                title: "Share instantly",
                body: "Markdown, HTML, or the direct SVG URL.",
              },
            ].map((item) => (
              <Card
                key={item.label}
                className="flex h-full flex-col justify-between border border-foreground/10 bg-card/90 p-6"
              >
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{item.label}</p>
                <div className="mt-4 space-y-2">
                  <h4 className="text-lg font-semibold">{item.title}</h4>
                  <p className="text-sm text-muted-foreground">{item.body}</p>
                </div>
                <div className="mt-6 h-1 w-12 rounded-full bg-primary/70" />
              </Card>
            ))}
          </section>
        </main>

        <footer className="relative z-10 border-t border-foreground/10 bg-background/70">
          <div className="container mx-auto flex flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground md:flex-row">
            <p className="text-center md:text-left">
              Built by{" "}
              <a
                href="https://shaonresume.netlify.app"
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-foreground hover:underline"
              >
                Shaon Majumder
              </a>{" "}
              - Senior Software Engineer (AI &amp; Scalability)
            </p>

            <div className="flex flex-wrap items-center justify-center gap-4 md:justify-end">
              <a
                href="https://www.linkedin.com/in/shaonmajumder"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground hover:underline"
              >
                LinkedIn
              </a>
              <a
                href="https://github.com/ShaonMajumder"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground hover:underline"
              >
                GitHub
              </a>
              <a
                href="https://medium.com/@shaonmajumder"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground hover:underline"
              >
                Medium
              </a>
              <a
                href="https://shaonresume.netlify.app"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground hover:underline"
              >
                Portfolio
              </a>
              <a
                href="https://docs.google.com/document/d/1frKGGkaE1nG9G8mTkxUoPfcU0jppSZYOy4VMPTlIb-Y/"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground hover:underline"
              >
                Resume
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default Index;
