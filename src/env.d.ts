declare namespace App {
  interface Locals {
    /** The signed-in staff member, or null. Set by the middleware for admin routes and actions. */
    staff: import("./lib/auth/staff").StaffSession | null;
  }
}
