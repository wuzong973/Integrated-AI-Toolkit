import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import {
  CreateConversationSchema,
  MessageListQuerySchema,
  SendMessageSchema,
  type ConversationItemDto,
  type ConversationPageDto,
  type CreateConversationDto,
  type MessageItemDto,
  type MessageListQueryDto,
  type MessagePageDto,
  type SendMessageDto,
} from './dto/conversation.dto';
import { ConversationService } from './conversation.service';

/**
 * 会话与消息（任务清单 M3-19）
 *
 * 与站内信同属一个模块、两个前缀：会话是"订单双方的沟通记录"，
 * 通知是"提醒你去看记录"，两者在 `ConversationService.send()` 里由**同一个事务**写出。
 *
 * 路由与 `apps/mp/utils/api.ts` 的 `conversationApi` 一一对应（`audit:api` 会核对）。
 * 全部需要登录，且**只有买卖双方**打得开 —— 越权与不存在同一句 404，见 service 文件头。
 */
@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Post()
  @ApiOperation({ summary: '按订单建/取会话（幂等；仅买卖双方，其他人 404）' })
  open(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateConversationSchema)) dto: CreateConversationDto,
  ): Promise<ConversationItemDto> {
    return this.conversations.open(user.id, dto.orderId);
  }

  @Get()
  @ApiOperation({ summary: '我的会话列表（带最后一条消息摘要与未读数）' })
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(MessageListQuerySchema)) query: MessageListQueryDto,
  ): Promise<ConversationPageDto> {
    return this.conversations.listMine(user.id, query);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: '会话消息（分页，createdAt 升序；读取即把对方消息置为已读）' })
  messages(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(MessageListQuerySchema)) query: MessageListQueryDto,
  ): Promise<MessagePageDto> {
    return this.conversations.messages(user.id, id, query);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: '发送消息（文本送审；同时给对方建一条未读通知）' })
  send(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SendMessageSchema)) dto: SendMessageDto,
  ): Promise<MessageItemDto> {
    return this.conversations.send(user.id, id, dto);
  }
}
