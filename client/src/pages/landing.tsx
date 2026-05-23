import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Brain, 
  Shield, 
  Zap, 
  Globe, 
  TrendingUp, 
  Activity, 
  ArrowRight, 
  CheckCircle2, 
  Star,
  Target,
  BarChart3,
  LineChart,
  Users,
  Award,
  Code,
  Rocket,
  Eye
} from "lucide-react";

export default function ScanstreamLanding() {
  return (
    <div className="min-h-screen bg-zinc-950 text-white overflow-hidden">
      {/* Navigation */}
      <nav className="border-b border-white/10 bg-zinc-950/80 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-cyan-400 to-purple-600 flex items-center justify-center">
              <Activity className="w-5 h-5" />
            </div>
            <span className="font-semibold text-2xl tracking-tighter">Scanstream</span>
          </div>

          <div className="hidden md:flex items-center gap-8 text-sm">
            <a href="#architecture" className="hover:text-cyan-400 transition-colors">Architecture</a>
            <a href="#features" className="hover:text-cyan-400 transition-colors">Features</a>
            <a href="#technology" className="hover:text-cyan-400 transition-colors">Technology</a>
            <a href="#why" className="hover:text-cyan-400 transition-colors">Why Scanstream</a>
          </div>

          <Button asChild className="bg-white text-black hover:bg-white/90">
            <a href="/dashboard">Launch Terminal</a>
          </Button>
        </div>
      </nav>

      {/* HERO */}
      <section className="pt-32 pb-20 relative">
        <div className="absolute inset-0 bg-[radial-gradient(#27272a_0.8px,transparent_1px)] [background-size:40px_40px] opacity-40" />
        
        <div className="max-w-5xl mx-auto px-6 text-center relative z-10">
          <Badge variant="outline" className="mb-6 border-cyan-400/30 text-cyan-400 px-4 py-1">
            Institutional-Grade Autonomous Trading
          </Badge>

          <h1 className="text-6xl md:text-7xl font-bold tracking-tighter mb-6 leading-none">
            The Trading System<br />
            <span className="bg-gradient-to-r from-cyan-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
              That Thinks
            </span>
          </h1>

          <p className="text-xl md:text-2xl text-zinc-400 max-w-3xl mx-auto mb-10">
            Multi-agent council • Reinforcement learning • Real-time integrity • 
            Cross-exchange truth engine • Regime-aware execution.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Button size="lg" asChild className="text-lg px-10 h-14 bg-white text-black hover:bg-white/90">
              <a href="/dashboard">Enter the Terminal</a>
            </Button>
            
            <Button size="lg" variant="outline" className="text-lg px-8 h-14 border-white/30 hover:bg-white/5">
              Watch System Overview
            </Button>
          </div>

          <div className="mt-16 flex justify-center gap-8 text-sm text-zinc-500">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
              LIVE Multi-Exchange
            </div>
            <div>13-Agent Council</div>
            <div>Closed-Loop RL</div>
            <div>Mode-Aware Safety</div>
          </div>
        </div>
      </section>

      {/* ARCHITECTURE */}
      <section id="architecture" className="py-20 border-t border-white/10 bg-zinc-900/50">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold mb-3">A Complete Autonomous System</h2>
            <p className="text-zinc-400 max-w-md mx-auto">
              Every layer was built with purpose — from raw data to intelligent execution.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              { 
                title: "Data Foundation", 
                items: ["Candle Integrity Layer", "Cross-Exchange Aggregator", "Truth Engine", "Symbol Manager"],
                color: "from-cyan-400 to-blue-500"
              },
              { 
                title: "Intelligence Layer", 
                items: ["Multi-Agent Council", "Momentum + Clustering", "ML + LSTM Signals", "Reversal Detection"],
                color: "from-purple-400 to-pink-500"
              },
              { 
                title: "Execution & Learning", 
                items: ["Mode-Aware Confidence", "Dynamic Exit Strategies", "RL Feedback Loop", "Risk & Position Manager"],
                color: "from-emerald-400 to-teal-500"
              }
            ].map((section, i) => (
              <Card key={i} className="bg-zinc-900 border-white/10 p-8 hover:border-white/20 transition-all">
                <div className={`w-12 h-1.5 rounded bg-gradient-to-r ${section.color} mb-6`} />
                <h3 className="text-2xl font-semibold mb-6">{section.title}</h3>
                <ul className="space-y-3">
                  {section.items.map((item, idx) => (
                    <li key={idx} className="flex items-center gap-3 text-zinc-300">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">Core Capabilities</h2>
            <p className="text-zinc-400">Everything you need for consistent edge</p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {[
              {
                icon: Brain,
                title: "Multi-Agent Council",
                desc: "RPG pattern agents + Physics validation + ML + RL vote in real-time with regime-aware weighting."
              },
              {
                icon: Shield,
                title: "Data Integrity Engine",
                desc: "Candle validation, gap detection, cross-batch continuity, and freshness awareness."
              },
              {
                icon: Globe,
                title: "Cross-Exchange Truth",
                desc: "Aggregates multiple venues into a canonical price with confidence scoring."
              },
              {
                icon: Zap,
                title: "Mode-Aware Safety",
                desc: "REPLAY / MIXED / LIVE awareness prevents false confidence during backfill."
              },
              {
                icon: TrendingUp,
                title: "Adaptive Execution",
                desc: "Dynamic entry timing, cluster validation, regime-aware exits, and adaptive holding."
              },
              {
                icon: LineChart,
                title: "Closed-Loop Learning",
                desc: "Reinforcement learning with domain-specific rewards across 5 decision areas."
              }
            ].map((feature, i) => (
              <Card key={i} className="bg-zinc-900 border-white/10 p-8 hover:border-white/30 transition-all group">
                <feature.icon className="h-10 w-10 mb-6 text-cyan-400 group-hover:scale-110 transition-transform" />
                <h3 className="text-2xl font-semibold mb-3">{feature.title}</h3>
                <p className="text-zinc-400 leading-relaxed">{feature.desc}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 bg-gradient-to-b from-transparent via-zinc-900 to-black border-t border-white/10">
        <div className="max-w-3xl mx-auto text-center px-6">
          <h2 className="text-5xl font-bold mb-6">Ready to run a real system?</h2>
          <p className="text-xl text-zinc-400 mb-10">
            Scanstream is not another signal service.<br />
            It's a complete autonomous trading platform.
          </p>
          
          <Button size="lg" asChild className="text-lg h-14 px-12 bg-white text-black hover:bg-white/90">
            <a href="/dashboard">Launch Scanstream Terminal</a>
          </Button>
          
          <p className="text-sm text-zinc-500 mt-6">Built with integrity. Designed for edge.</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 py-12 bg-black">
        <div className="max-w-7xl mx-auto px-6 text-center text-zinc-500 text-sm">
          © 2026 Scanstream • Built as a serious autonomous trading platform
        </div>
      </footer>
    </div>
  );
}