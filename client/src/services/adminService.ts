/**
 * Admin Service - Handles admin operations like clear kill, status checks
 */

interface AdminStatus {
  kill: {
    killed: boolean;
    reason?: string;
    setBy?: string;
    timestamp?: number;
  };
  live?: any;
}

interface ClearResponse {
  ok: boolean;
  state: AdminStatus['kill'];
}

class AdminService {
  private baseUrl: string;
  private adminSecret: string | null = null;

  constructor() {
    this.baseUrl = import.meta.env.VITE_API_URL || window.location.origin;
    // Load admin secret from localStorage for dev convenience
    this.adminSecret = this.loadAdminSecret();
  }

  /**
   * Load admin secret from localStorage (dev convenience)
   */
  private loadAdminSecret(): string | null {
    if (import.meta.env.DEV) {
      try {
        return localStorage.getItem('ADMIN_SECRET');
      } catch (e) {
        console.warn('[AdminService] Failed to load admin secret from localStorage:', e);
        return null;
      }
    }
    return null;
  }

  /**
   * Save admin secret to localStorage (dev convenience)
   */
  setAdminSecret(secret: string): void {
    if (import.meta.env.DEV) {
      this.adminSecret = secret;
      try {
        localStorage.setItem('ADMIN_SECRET', secret);
      } catch (e) {
        console.warn('[AdminService] Failed to save admin secret to localStorage:', e);
      }
    }
  }

  /**
   * Get current admin secret
   */
  getAdminSecret(): string | null {
    return this.adminSecret;
  }

  /**
   * Clear the admin secret
   */
  clearAdminSecret(): void {
    this.adminSecret = null;
    if (import.meta.env.DEV) {
      try {
        localStorage.removeItem('ADMIN_SECRET');
      } catch (e) {
        console.warn('[AdminService] Failed to clear admin secret from localStorage:', e);
      }
    }
  }

  /**
   * Get admin status (can be called without auth)
   */
  async getAdminStatus(): Promise<AdminStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/admin/status`);
      if (!response.ok) {
        throw new Error(`Failed to fetch admin status: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error('[AdminService] Error fetching admin status:', error);
      throw error;
    }
  }

  /**
   * Clear the kill switch
   */
  async clearKill(reason?: string): Promise<ClearResponse> {
    if (!this.adminSecret) {
      throw new Error('Admin secret not set. Please configure it first.');
    }

    try {
      const response = await fetch(`${this.baseUrl}/admin/clear`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': this.adminSecret,
        },
        body: JSON.stringify({
          clearedBy: 'dashboard-ui',
          reason,
          timestamp: Date.now(),
        }),
      });

      if (response.status === 401) {
        throw new Error('Unauthorized: Invalid admin secret');
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Failed to clear kill: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[AdminService] Error clearing kill:', error);
      throw error;
    }
  }

  /**
   * Get portfolio P&L data (numeric USD)
   */
  async getPortfolioPnL(): Promise<{ pnl: number; pnlPercent: number; totalValue: number }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/portfolio/summary`);
      if (!response.ok) {
        throw new Error(`Failed to fetch portfolio P&L: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Calculate P&L from the equity curve or performance metrics
      const pnl = data.dayChange || 0;
      const pnlPercent = data.dayChangePercent || 0;
      const totalValue = data.totalValue || 0;

      return { pnl, pnlPercent, totalValue };
    } catch (error) {
      console.error('[AdminService] Error fetching portfolio P&L:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const adminService = new AdminService();
