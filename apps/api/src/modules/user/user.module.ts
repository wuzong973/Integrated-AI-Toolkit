import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { UserController } from './user.controller';
import { UserService } from './user.service';

/** 用户模块（任务清单 M0-20） */
@Module({
  imports: [AuthModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
