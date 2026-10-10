// Web replacement for hle/net/network_ssl.cpp. Browsers have no raw sockets, so the web build
// keeps guest networking off: Network_HLE_OpenDevice never opens /dev/net/ip/top or
// /dev/net/ssl there, and nothing reaches these entry points. They exist so the shared socket
// code links without mbed TLS.
#include "hle/net/network_internal.h"

namespace NetworkHle {

NasSslWriteAction PreparePlainNasTcpWrite(WiiSocket&, const uint8_t*, uint32_t, std::vector<uint8_t>&) {
    return NasSslWriteAction::PassThrough;
}

void ClearSslSessionsForSocket(uint32_t) {}

int32_t HandleSslIoctlv(uint32_t, const std::vector<IoVector>&, const std::vector<IoVector>&) {
    return -1;
}

}  // namespace NetworkHle
