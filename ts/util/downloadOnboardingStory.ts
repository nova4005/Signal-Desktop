// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { AttachmentType } from '../types/Attachment';
import type { MessageAttributesType } from '../model-types.d';
import type { MessageModel } from '../models/messages';
import * as log from '../logging/log';
import { IMAGE_JPEG } from '../types/MIME';
import { ReadStatus } from '../messages/MessageReadStatus';
import { SeenStatus } from '../MessageSeenStatus';
import { UUID } from '../types/UUID';
import { findAndDeleteOnboardingStoryIfExists } from './findAndDeleteOnboardingStoryIfExists';
import { runStorageServiceSyncJob } from '../services/storage';
import { saveNewMessageBatcher } from './messageBatcher';
import { strictAssert } from './assert';

// * Check if we've viewed onboarding story. Short circuit.
// * Run storage service sync (just in case) and check again.
// * If it has been viewed and it's downloaded on this device, delete & return.
// * Check if we've already downloaded the onboarding story.
// * Download onboarding story, create db entry, mark as downloaded.
// * If story has been viewed mark as viewed on AccountRecord.
// * If we viewed it >24 hours ago, delete.
export async function downloadOnboardingStory(): Promise<void> {
  const hasViewedOnboardingStory = window.storage.get(
    'hasViewedOnboardingStory'
  );

  if (hasViewedOnboardingStory) {
    await findAndDeleteOnboardingStoryIfExists();
    return;
  }

  runStorageServiceSyncJob();

  window.Whisper.events.once(
    'storageService:syncComplete',
    continueDownloadingOnboardingStory
  );
}

async function continueDownloadingOnboardingStory(): Promise<void> {
  const { server } = window.textsecure;

  strictAssert(server, 'server not initialized');

  const hasViewedOnboardingStory = window.storage.get(
    'hasViewedOnboardingStory'
  );

  if (hasViewedOnboardingStory) {
    await findAndDeleteOnboardingStoryIfExists();
    return;
  }

  const existingOnboardingStoryMessageIds = window.storage.get(
    'existingOnboardingStoryMessageIds'
  );

  if (existingOnboardingStoryMessageIds) {
    log.info('downloadOnboardingStory: has existingOnboardingStoryMessageIds');
    return;
  }

  const userLocale = window.i18n.getLocale();

  const manifest = await server.getOnboardingStoryManifest();

  log.info('downloadOnboardingStory: got manifest version:', manifest.version);

  const imageFilenames =
    userLocale in manifest.languages
      ? manifest.languages[userLocale]
      : manifest.languages.en;

  const imageBuffers = await server.downloadOnboardingStories(
    manifest.version,
    imageFilenames
  );

  log.info('downloadOnboardingStory: downloaded stories:', imageBuffers.length);

  const attachments: Array<AttachmentType> = await Promise.all(
    imageBuffers.map(data => {
      const attachment: AttachmentType = {
        contentType: IMAGE_JPEG,
        data,
        size: data.byteLength,
      };

      return window.Signal.Migrations.processNewAttachment(attachment);
    })
  );

  log.info('downloadOnboardingStory: getting signal conversation');
  const signalConversation =
    await window.ConversationController.getOrCreateSignalConversation();

  const storyMessages: Array<MessageModel> = attachments.map(
    (attachment, index) => {
      const timestamp = Date.now() + index;

      const partialMessage: MessageAttributesType = {
        attachments: [attachment],
        canReplyToStory: false,
        conversationId: signalConversation.id,
        id: UUID.generate().toString(),
        readStatus: ReadStatus.Unread,
        received_at: window.Signal.Util.incrementMessageCounter(),
        received_at_ms: timestamp,
        seenStatus: SeenStatus.Unseen,
        sent_at: timestamp,
        serverTimestamp: timestamp,
        sourceUuid: signalConversation.get('uuid'),
        timestamp,
        type: 'story',
      };
      return new window.Whisper.Message(partialMessage);
    }
  );

  await Promise.all(
    storyMessages.map(message => saveNewMessageBatcher.add(message.attributes))
  );

  // Sync to redux
  storyMessages.forEach(message => {
    message.trigger('change');
  });

  await window.storage.put(
    'existingOnboardingStoryMessageIds',
    storyMessages.map(message => message.id)
  );

  log.info('downloadOnboardingStory: done');
}
