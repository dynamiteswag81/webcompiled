// Web replacement for discord_presence.cpp: a page cannot reach the local Discord client's IPC
// socket, so the /dev/dolphin presence calls are accepted and dropped.
#include "discord_presence.h"

namespace DiscordPresence {

void Initialize(const std::string&, const std::string&) {}
void SetClient(const std::string&) {}
void SetActivity(Activity) {}
void Reset() {}
void Shutdown() {}

} // namespace DiscordPresence
