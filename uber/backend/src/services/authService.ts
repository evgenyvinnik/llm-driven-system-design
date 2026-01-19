import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { query } from '../utils/db.js';
import redis from '../utils/redis.js';
import config from '../config/index.js';
import type { AuthResult, User, VehicleInfo, UserRow, DriverRow } from '../types/index.js';

const SESSION_PREFIX = 'session:';

class AuthService {
  // Register a new user
  async register(
    email: string,
    password: string,
    name: string,
    phone: string | null,
    userType: 'rider' | 'driver'
  ): Promise<AuthResult> {
    // Check if user exists
    const existing = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return { success: false, error: 'Email already registered' };
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query<UserRow>(
      `INSERT INTO users (email, password_hash, name, phone, user_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, phone, user_type, rating`,
      [email, passwordHash, name, phone, userType]
    );

    const user = result.rows[0];

    // Create session
    const token = await this.createSession(user.id);

    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        userType: user.user_type,
        rating: parseFloat(user.rating),
      },
      token,
    };
  }

  // Register a driver (extends user registration)
  async registerDriver(
    email: string,
    password: string,
    name: string,
    phone: string | null,
    vehicleInfo: VehicleInfo
  ): Promise<AuthResult> {
    const userResult = await this.register(email, password, name, phone, 'driver');

    if (!userResult.success || !userResult.user) {
      return userResult;
    }

    // Create driver profile
    await query(
      `INSERT INTO drivers (user_id, vehicle_type, vehicle_make, vehicle_model, vehicle_color, license_plate)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userResult.user.id,
        vehicleInfo.vehicleType,
        vehicleInfo.vehicleMake,
        vehicleInfo.vehicleModel,
        vehicleInfo.vehicleColor,
        vehicleInfo.licensePlate,
      ]
    );

    return {
      ...userResult,
      user: {
        ...userResult.user,
        vehicle: vehicleInfo,
      },
    };
  }

  // Login user
  async login(email: string, password: string): Promise<AuthResult> {
    const result = await query<DriverRow>(
      `SELECT u.*, d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate,
              d.is_available, d.is_online, d.total_rides, d.total_earnings_cents
       FROM users u
       LEFT JOIN drivers d ON u.id = d.user_id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'Invalid email or password' };
    }

    const user = result.rows[0];

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return { success: false, error: 'Invalid email or password' };
    }

    // Create session
    const token = await this.createSession(user.id);

    const response: AuthResult = {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        userType: user.user_type,
        rating: parseFloat(user.rating),
      },
      token,
    };

    // Add driver info if applicable
    if (user.user_type === 'driver' && response.user) {
      response.user.vehicle = {
        vehicleType: user.vehicle_type,
        vehicleMake: user.vehicle_make,
        vehicleModel: user.vehicle_model,
        vehicleColor: user.vehicle_color,
        licensePlate: user.license_plate,
      };
      response.user.isAvailable = user.is_available;
      response.user.isOnline = user.is_online;
      response.user.totalRides = user.total_rides;
      response.user.totalEarningsCents = user.total_earnings_cents;
    }

    return response;
  }

  // Create a session
  async createSession(userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.session.expiresIn);

    // Store in PostgreSQL
    await query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userId, token, expiresAt]
    );

    // Store in Redis for fast lookup
    await redis.setex(
      `${SESSION_PREFIX}${token}`,
      Math.floor(config.session.expiresIn / 1000),
      userId
    );

    return token;
  }

  // Validate session and get user
  async validateSession(token: string): Promise<User | null> {
    if (!token) {
      return null;
    }

    // Try Redis first
    let userId = await redis.get(`${SESSION_PREFIX}${token}`);

    if (!userId) {
      // Fall back to database
      const result = await query<{ user_id: string }>(
        'SELECT user_id FROM sessions WHERE token = $1 AND expires_at > NOW()',
        [token]
      );

      if (result.rows.length === 0) {
        return null;
      }

      userId = result.rows[0].user_id;

      // Cache in Redis
      await redis.setex(`${SESSION_PREFIX}${token}`, 3600, userId);
    }

    // Get user details
    const userResult = await query<DriverRow>(
      `SELECT u.*, d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate,
              d.is_available, d.is_online, d.total_rides, d.total_earnings_cents
       FROM users u
       LEFT JOIN drivers d ON u.id = d.user_id
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return null;
    }

    const user = userResult.rows[0];

    const response: User = {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      userType: user.user_type,
      rating: parseFloat(user.rating),
    };

    if (user.user_type === 'driver') {
      response.vehicle = {
        vehicleType: user.vehicle_type,
        vehicleMake: user.vehicle_make,
        vehicleModel: user.vehicle_model,
        vehicleColor: user.vehicle_color,
        licensePlate: user.license_plate,
      };
      response.isAvailable = user.is_available;
      response.isOnline = user.is_online;
      response.totalRides = user.total_rides;
      response.totalEarningsCents = user.total_earnings_cents;
    }

    return response;
  }

  // Logout
  async logout(token: string): Promise<{ success: boolean }> {
    await redis.del(`${SESSION_PREFIX}${token}`);
    await query('DELETE FROM sessions WHERE token = $1', [token]);
    return { success: true };
  }

  // Get user by ID
  async getUserById(userId: string): Promise<User | null> {
    const result = await query<DriverRow>(
      `SELECT u.*, d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate,
              d.is_available, d.is_online, d.total_rides, d.total_earnings_cents
       FROM users u
       LEFT JOIN drivers d ON u.id = d.user_id
       WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      userType: user.user_type,
      rating: parseFloat(user.rating),
      ratingCount: user.rating_count,
      vehicle:
        user.user_type === 'driver'
          ? {
              vehicleType: user.vehicle_type,
              vehicleMake: user.vehicle_make,
              vehicleModel: user.vehicle_model,
              vehicleColor: user.vehicle_color,
              licensePlate: user.license_plate,
            }
          : null,
      isAvailable: user.is_available,
      isOnline: user.is_online,
      totalRides: user.total_rides,
      totalEarningsCents: user.total_earnings_cents,
    };
  }
}

export default new AuthService();
