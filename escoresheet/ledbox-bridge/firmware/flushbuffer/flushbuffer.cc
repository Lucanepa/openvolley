// flushBuffer2 — KSC Wiedikon open rebuild of the Tech4Sport flushBuffer.
//
// Displays a PNG on the LED matrix, reloading it each frame (~62 fps), exactly
// like the vendor binary — but built on the open-source hzeller
// rpi-rgb-led-matrix library with the custom `applicon` GPIO mapping, with NO
// licence check and NO GraphicsMagick (PNG via stb_image). It links only stock
// Debian-12 libraries, so the /home/pi/ledbox/lib legacy staging
// (libcrypto1.1 / libtiff5 / libwebp6 / GraphicsMagick) is no longer needed.
//
// The geometry and scan_mode are compiled in, exactly as the vendor did — they
// are NOT passed on the command line. Any --led-* flag still overrides them
// (CreateMatrixFromFlags runs after these defaults, mirroring the vendor main).
//
// Effective config recovered from the vendor binary (unstripped, via gdb/objdump):
//   rows=64 cols=64 chain=3 parallel=1 scan_mode=1  -> 192x64
//   gpio-mapping=applicon  slowdown=5  pwm-bits=7  pwm-lsb=450  dither=2
//   multiplexing=1  brightness=40

#include "led-matrix.h"
#include <signal.h>
#include <stdio.h>
#include <unistd.h>
#include <stddef.h>

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#include "stb_image.h"

using rgb_matrix::RGBMatrix;
using rgb_matrix::FrameCanvas;

static volatile sig_atomic_t interrupt_received = 0;
static void InterruptHandler(int) { interrupt_received = 1; }

int main(int argc, char *argv[]) {
  const char *image_path =
      (argc > 1 && argv[1][0] != '-') ? argv[1] : "/home/pi/ledbox/www/buffer.png";

  RGBMatrix::Options opt;
  rgb_matrix::RuntimeOptions rt;
  opt.hardware_mapping    = "applicon";
  opt.rows                = 64;
  opt.cols                = 64;
  opt.chain_length        = 3;
  opt.parallel            = 1;
  opt.scan_mode           = 1;
  opt.pwm_bits            = 7;
  opt.pwm_lsb_nanoseconds = 450;
  opt.pwm_dither_bits     = 2;
  opt.brightness          = 40;
  opt.multiplexing        = 1;
  rt.gpio_slowdown        = 5;

  RGBMatrix *matrix = rgb_matrix::CreateMatrixFromFlags(&argc, &argv, &opt, &rt);
  if (matrix == NULL) { fprintf(stderr, "flushBuffer2: could not init matrix\n"); return 1; }

  signal(SIGTERM, InterruptHandler);
  signal(SIGINT, InterruptHandler);

  FrameCanvas *canvas = matrix->CreateFrameCanvas();
  const int W = matrix->width();
  const int H = matrix->height();

  while (!interrupt_received) {
    int w = 0, h = 0, comp = 0;
    unsigned char *px = stbi_load(image_path, &w, &h, &comp, 3);
    if (px != NULL) {
      const int cw  = (w < W) ? w : W;
      const int chh = (h < H) ? h : H;
      canvas->Fill(0, 0, 0);
      for (int y = 0; y < chh; ++y) {
        const unsigned char *rowp = px + (size_t)y * w * 3;
        for (int x = 0; x < cw; ++x) {
          const unsigned char *p = rowp + x * 3;
          canvas->SetPixel(x, y, p[0], p[1], p[2]);
        }
      }
      stbi_image_free(px);
      canvas = matrix->SwapOnVSync(canvas);
    }
    usleep(16000);  // ~62 fps, matching the vendor
  }

  matrix->Clear();
  delete matrix;
  return 0;
}
