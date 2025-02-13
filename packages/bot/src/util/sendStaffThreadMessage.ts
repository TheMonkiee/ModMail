import { setTimeout } from 'node:timers';
import { EmbedBuilder, bold, inlineCode } from '@discordjs/builders';
import { PrismaClient } from '@prisma/client';
import type {
	Attachment,
	GuildMember,
	ChatInputCommandInteraction,
	MessageEditOptions,
	ThreadChannel,
	Message,
	MessageContextMenuCommandInteraction,
	MessageCreateOptions,
} from 'discord.js';
import { Colors } from 'discord.js';
import i18next from 'i18next';
import { container } from 'tsyringe';
import { logger } from './logger';
import { templateDataFromMember, templateString } from '#util/templateString';

export type SendStaffThreadMessageOptions = {
	anon: boolean;
	attachment?: Attachment | null;
	channel: ThreadChannel;
	content: string;
	existing?: { guild: Message; replyId: number; user: Message };
	interaction?: ChatInputCommandInteraction<'cached'> | MessageContextMenuCommandInteraction<'cached'>;
	member: GuildMember;
	simpleMode: boolean;
	staff: GuildMember;
	threadId: number;
};

export async function sendStaffThreadMessage({
	content,
	attachment,
	staff,
	member,
	channel,
	threadId,
	simpleMode,
	anon,
	interaction,
	existing,
}: SendStaffThreadMessageOptions) {
	const prisma = container.resolve(PrismaClient);
	// eslint-disable-next-line no-param-reassign
	content = templateString(content, templateDataFromMember(member));

	const options: Omit<MessageEditOptions, 'flags'> = { allowedMentions: { roles: [] } };
	if (simpleMode) {
		options.content = `${bold(
			`${existing ? `${inlineCode(existing.replyId.toString())} ` : ''}${anon ? '(Anonymous) ' : ''}(${
				staff.guild.name
			} Team) Server Moderators:`,
		)} ${content}`;
		if (attachment) {
			options.files = [attachment];
		} else {
			options.files = [];
			options.attachments = [];
		}
	} else {
		const embed = new EmbedBuilder()
			.setColor(Colors.Blurple)
			.setDescription(content)
			.setImage(attachment?.url ?? null)
			.setFooter({
				text: `${existing ? `Reply ID: ${existing.replyId} | ` : ''}${staff.user.tag} (${staff.user.id})`,
				iconURL: staff.user.displayAvatarURL(),
			});

		if (anon) {
			embed.setAuthor({
				name: "Server Moderators",
				iconURL: staff.guild.iconURL() ?? undefined,
			});
		}

		if (staff.nickname && !anon) {
			embed.setAuthor({
				name: staff.displayName,
				iconURL: staff.displayAvatarURL(),
			});
		}

		options.embeds = [embed];
	}

	const userOptions = { ...options };
	// Now that we've sent the message locally, we can purge all identifying information from anon messages
	if (anon) {
		if (simpleMode) {
			userOptions.content = `${bold(
				`${existing ? `${inlineCode(existing.replyId.toString())} ` : ''}(Anonymous) Server Moderators:`,
			)} ${content}`;
		} else {
			const [embed] = userOptions.embeds as [EmbedBuilder];
			const newEmbed = new EmbedBuilder(embed.toJSON());
			newEmbed.setFooter(null);
			userOptions.embeds = [newEmbed];
		}
	}

	if (existing) {
		await interaction?.reply({ content: 'Successfully edited your message' });
		setTimeout(async () => {
			try {
				await interaction?.deleteReply();
			} catch (error) {
				logger.error(error, 'Bad interaction.deleteReply()');
			}
		}, 1_500);
		await existing.guild.edit(options);
		return existing.user.edit(userOptions);
	}

	const guildMessage = await channel.send(options as MessageCreateOptions);
	await interaction?.reply({ content: 'Successfully posted your message' });
	setTimeout(async () => {
		try {
			await interaction?.deleteReply();
		} catch (error) {
			logger.error(error, 'Bad interaction.deleteReply()');
		}
	}, 1_500);

	let userMessage: Message;
	try {
		userMessage = await member.send(userOptions as MessageCreateOptions);
	} catch {
		return channel.send(i18next.t('common.errors.dm_fail'));
	}

	const { lastLocalThreadMessageId: localThreadMessageId } = await prisma.thread.update({
		data: { lastLocalThreadMessageId: { increment: 1 } },
		where: { threadId },
	});

	const threadMessage = await prisma.threadMessage.create({
		data: {
			guildId: member.guild.id,
			localThreadMessageId,
			threadId,
			userId: member.user.id,
			userMessageId: userMessage.id,
			guildMessageId: guildMessage.id,
			staffId: staff.user.id,
			anon,
		},
	});

	// Edit the reply ID in
	if (simpleMode) {
		options.content = `${inlineCode(threadMessage.localThreadMessageId.toString())} ${options.content!}`;
	} else {
		const [embed] = options.embeds as [EmbedBuilder];
		embed.setFooter({
			text: `Reply ID: ${threadMessage.localThreadMessageId} | ${staff.user.tag} (${staff.user.id})`,
			iconURL: staff.user.displayAvatarURL(),
		});
		options.embeds = [embed];
	}

	return guildMessage.edit(options as MessageEditOptions);
}
