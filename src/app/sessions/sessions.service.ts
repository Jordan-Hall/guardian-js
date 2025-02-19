import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigValue } from '@ultimate-backend/config';
import { RedisClient } from '@ultimate-backend/redis';
import { isEmail } from 'class-validator';
import { lookup } from 'geoip-lite';
import { Address6 } from 'ip-address';
import { FeaturesConfig, FieldsPolicyConfig, Identity } from '../common';
import { BaseDatastore } from '../data-stores/stores';
import { JwtService } from '../jwt/jwt.service';
import { PasswordService } from '../password/password.service';
import { CreateSessionRequest } from './commands';
import { SessionResponse } from './queries';

@Injectable()
export class SessionsService {
  @ConfigValue('features', {})
  featuresConfig: FeaturesConfig;

  @ConfigValue('fieldsPolicy', {})
  fieldPolicyConfig: FieldsPolicyConfig;

  constructor(
    private readonly datastore: BaseDatastore<any>,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisClient,
  ) {}

  /**
   * @description this method creates a session for an account
   * @param cmd
   * @param identity
   * @param ipAddress
   */
  async create(
    cmd: CreateSessionRequest,
    identity: Identity,
    ipAddress?: string | string[],
  ): Promise<SessionResponse> {
    let addr;
    if (ipAddress) {
      const address = new Address6(ipAddress);
      const teredo = address.inspectTeredo();
      addr = teredo.client4;
      lookup(addr);
    }

    if (!this.fieldPolicyConfig.email.enabled && isEmail(cmd.identity)) {
      throw new UnauthorizedException('Please email authentication is disabled');
    }

    if (
      !this.fieldPolicyConfig.phoneNumber.enabled &&
      cmd.identity.match(/^[+]\d{1,3}-\d+/g)
    ) {
      throw new UnauthorizedException('Please phone number authentication is disabled');
    }

    const account = await this.datastore.account.findByIdentity(cmd.identity);
    if (!(await this.passwordService.verifyPassword(account.password, cmd.password))) {
      throw new NotFoundException(
        'Your identity [email, username, phoneNumber] or password is incorrect',
      );
    }

    if (account.locked) {
      throw new UnauthorizedException(
        'Your account has been locked out, please contact support',
      );
    }

    if (account.requireNewPassword) {
      throw new UnauthorizedException('Please request new password change');
    }

    if (
      this.featuresConfig.auth.loginRequireConfirmation &&
      account.metadata.verifiedIdentities.findIndex((id) => id === cmd.identity) === -1
    ) {
      throw new UnauthorizedException('Please verify your account');
    }

    if (
      this.fieldPolicyConfig.email.requireConfirmation &&
      isEmail(cmd.identity) &&
      account.metadata.verifiedIdentities.findIndex((id) => id === cmd.identity) === -1
    ) {
      throw new UnauthorizedException('Please verify your email for this account');
    }

    if (
      this.fieldPolicyConfig.email.requireConfirmation &&
      cmd.identity.match(/^[+]\d{1,3}-\d+/g) &&
      account.metadata.verifiedIdentities.findIndex((id) => id === cmd.identity) === -1
    ) {
      throw new UnauthorizedException('Please verify your phone number for this account');
    }

    const accountToken = this.jwtService.createPublicClaim({
      sub: account.id,
      email: account.email,
      phone_number: account.phoneNumber,
      username: account.username,
    });

    if (this.featuresConfig.auth.enableSession) {
      identity.remember(accountToken);
    }

    if (this.featuresConfig.auth.enableJwt) {
      await this.redis.client.set(accountToken, true)
    }

    await this.datastore.account.setLastLogin(account.id, addr);

    return {
      idToken: this.featuresConfig.auth.enableJwt ? accountToken : null,
    };
  }

  /**
   * @description delete account session
   * @param identity
   */
  delete(identity: Identity): boolean {
    identity.forget();
    return true;
  }
}
