---
title: "嵌入式 C/C++ 工程化：从能跑到能维护"
date: 2025-10-08T10:00:00+08:00
categories: ["知识向"]
tags: ["嵌入式", "C", "C++", "工程化", "CMake"]
cover: /images/guides/embedded-engineering/cover.png
top_img: false
---

写出能跑的代码不难，难的是六个月后自己还能看懂，换人维护不崩溃，新功能加进去不引入 bug。这就是工程化要解决的问题。

嵌入式项目有自己的特殊性：硬件依赖重、交叉编译环境复杂、资源受限导致测试困难。本文从项目结构、构建系统、代码规范、单元测试到 CI，讲的不是理论，而是实际能落地的做法。

---

## 一、项目结构

### 为什么需要规范的目录结构

很多嵌入式项目的早期状态是这样的：所有 `.c` 和 `.h` 文件堆在同一个目录，Makefile 手写，头文件互相 include 没有层次，第三方库直接复制进来和业务代码混在一起。项目小的时候没问题，一旦文件数量上去，依赖关系就会变成一张说不清楚的网。

规范目录结构的意义不是为了好看，而是让每个文件的定位一目了然，让构建系统能自动找到该找的东西，让新人接手时不需要靠口口相传才能理解项目。

### 推荐结构

```
project/
├── CMakeLists.txt          # 顶层构建入口
├── cmake/                  # CMake 工具链、辅助脚本
│   └── arm-linux.cmake     # 交叉编译工具链文件
├── include/                # 公共头文件（对外接口）
│   └── project/
│       ├── sensor.h
│       └── comm.h
├── src/                    # 源文件和内部头文件
│   ├── sensor.c
│   ├── comm.c
│   └── internal.h          # 内部用，不对外暴露
├── drivers/                # 硬件驱动层
│   ├── uart/
│   └── spi/
├── third_party/            # 第三方库，不修改
│   └── cjson/
├── test/                   # 单元测试
│   ├── test_sensor.c
│   └── test_comm.c
├── scripts/                # 烧录、调试、CI 脚本
└── docs/                   # 文档
```

几个关键决策：

**include/ 和 src/ 分离**：`include/` 只放对外暴露的接口头文件，`src/` 放实现和内部头文件。这个分离有实际意义——编译别的模块时只需要 `-Iinclude`，不会意外依赖内部实现细节。库的使用者只需要拿走 `include/` 目录，不需要看源码。

**drivers/ 独立**：驱动和业务逻辑分层，驱动层只负责操作硬件寄存器，业务层通过接口调用驱动，不直接碰寄存器。这个分层是后面单元测试能做起来的基础。

**third_party/ 不改动**：第三方库放独立目录，永远不修改它的代码。需要定制就用 wrapper 包一层，这样升级第三方库时不会有冲突。

**test/ 和 src/ 平级**：测试代码不是附属品，和源码地位相同。放在独立目录方便构建时单独编译，也方便 CI 只跑测试不烧录。

---

## 二、构建系统：从 Makefile 到 CMake

### Makefile 的问题

手写 Makefile 在小项目里够用，但有几个痛点在项目变大后会持续困扰你：

**依赖管理容易漏**：手写头文件依赖（`.c` 依赖哪些 `.h`）很容易漏掉，改了头文件但对应的 `.c` 没有重新编译，导致链接的是旧版本的目标文件，bug 找半天找不到。虽然可以用 `gcc -MMD` 自动生成依赖，但要自己在 Makefile 里集成。

**交叉编译需要大改**：从本机编译切换到 ARM 交叉编译，要改 `CC`、`CXX`、`AR`、`SYSROOT`、`CFLAGS` 等一堆变量，而且这些改动和构建逻辑混在一起，很难维护两套配置。

**构建目录污染源码**：直接在源码目录里编译，`.o` 文件散落各处，`git status` 一片噪音，`make clean` 还容易漏掉。

CMake 解决的就是这些问题。

### CMake 基础结构

CMake 不直接编译，它生成 Makefile 或 Ninja 构建文件，然后由这些工具做实际编译。核心优势是描述式——你描述项目有哪些目标、依赖什么，CMake 负责生成正确的构建规则。

一个典型的嵌入式项目顶层 `CMakeLists.txt`：

```cmake
cmake_minimum_required(VERSION 3.16)
project(myproject C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

# 编译选项
add_compile_options(
    -Wall
    -Wextra
    -Werror
    -ffunction-sections
    -fdata-sections
)

# 添加子目录
add_subdirectory(src)
add_subdirectory(drivers)
add_subdirectory(test)
```

`src/CMakeLists.txt`：

```cmake
add_library(app_core STATIC
    sensor.c
    comm.c
)

target_include_directories(app_core
    PUBLIC  ${PROJECT_SOURCE_DIR}/include   # 对外暴露
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}     # 内部头文件
)
```

`target_include_directories` 的 `PUBLIC`/`PRIVATE`/`INTERFACE` 是 CMake 的关键概念：
- `PUBLIC`：编译这个 target 和依赖它的 target 时都用
- `PRIVATE`：只在编译这个 target 时用，不传递给依赖者
- `INTERFACE`：只传递给依赖者，自己不用（header-only 库用这个）

### Out-of-source 构建

CMake 的标准用法是在源码目录外建一个 `build/` 目录来编译：

```bash
mkdir build && cd build
cmake ..
make -j4
```

源码目录完全干净，`build/` 整个删掉就是彻底清理。不同配置（Debug/Release/交叉编译）可以建不同的 build 目录，互不干扰：

```bash
mkdir build-debug && cd build-debug
cmake .. -DCMAKE_BUILD_TYPE=Debug

mkdir build-release && cd build-release
cmake .. -DCMAKE_BUILD_TYPE=Release
```

### 交叉编译工具链文件

切换到 ARM 交叉编译只需要传一个工具链文件，不需要改 `CMakeLists.txt`：

```bash
cmake .. -DCMAKE_TOOLCHAIN_FILE=../cmake/arm-linux.cmake
```

`cmake/arm-linux.cmake`：

```cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR arm)

# 工具链前缀
set(CROSS_PREFIX arm-linux-gnueabihf-)

set(CMAKE_C_COMPILER   ${CROSS_PREFIX}gcc)
set(CMAKE_CXX_COMPILER ${CROSS_PREFIX}g++)
set(CMAKE_AR           ${CROSS_PREFIX}ar)
set(CMAKE_STRIP        ${CROSS_PREFIX}strip)

# sysroot（目标系统的根文件系统，包含目标平台的库和头文件）
set(CMAKE_SYSROOT /opt/arm-sysroot)
set(CMAKE_FIND_ROOT_PATH /opt/arm-sysroot)

# 在 sysroot 里找库和头文件，不在宿主机上找
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
```

同一份 `CMakeLists.txt`，本机编译和交叉编译靠工具链文件切换，构建逻辑完全不用改。

---

## 三、代码规范落地

代码规范文档写得再详细，执行靠人工 review 也会漏。真正有效的做法是把规范变成工具，让不符合规范的代码根本提交不进去。嵌入式 C/C++ 项目常用两个工具：clang-format 管格式，clang-tidy 管代码质量。

### clang-format：自动格式化

clang-format 根据配置文件自动格式化代码，不需要记规范，保存时自动跑。在项目根目录放一个 `.clang-format`：

```yaml
BasedOnStyle: Google
IndentWidth: 4
ColumnLimit: 100
BreakBeforeBraces: Attach
AllowShortFunctionsOnASingleLine: None
AllowShortIfStatementsOnASingleLine: Never
SortIncludes: true
```

手动格式化整个项目：

```bash
find src include drivers -name "*.c" -o -name "*.h" -o -name "*.cpp" | \
    xargs clang-format -i
```

集成到 CMake，构建时自动检查格式（不修改文件，只报错）：

```cmake
find_program(CLANG_FORMAT clang-format)
if(CLANG_FORMAT)
    file(GLOB_RECURSE ALL_SOURCE_FILES
        ${PROJECT_SOURCE_DIR}/src/*.c
        ${PROJECT_SOURCE_DIR}/src/*.h
        ${PROJECT_SOURCE_DIR}/include/*.h
    )
    add_custom_target(format-check
        COMMAND ${CLANG_FORMAT} --dry-run --Werror ${ALL_SOURCE_FILES}
        COMMENT "Checking code format..."
    )
endif()
```

CI 里跑 `cmake --build build --target format-check`，格式不对直接失败。

### clang-tidy：静态分析

clang-tidy 是静态分析工具，能发现编译器不报的问题：未初始化变量、整型溢出风险、空指针解引用、内存泄漏模式、C++ 现代化建议等。

在项目根目录放 `.clang-tidy`：

```yaml
Checks: >
  clang-diagnostic-*,
  clang-analyzer-*,
  bugprone-*,
  modernize-*,
  performance-*,
  readability-*,
  -modernize-use-trailing-return-type,
  -readability-magic-numbers
WarningsAsErrors: "*"
HeaderFilterRegex: "include/.*"
```

集成到 CMake：

```cmake
find_program(CLANG_TIDY clang-tidy)
if(CLANG_TIDY)
    set(CMAKE_C_CLANG_TIDY   ${CLANG_TIDY})
    set(CMAKE_CXX_CLANG_TIDY ${CLANG_TIDY})
endif()
```

设置了 `CMAKE_C_CLANG_TIDY` 之后，每次编译 `.c` 文件时 clang-tidy 自动跑，发现问题直接报错，和编译错误一起输出。

clang-tidy 需要 `compile_commands.json`（编译数据库）才能正确分析头文件依赖，生成方式：

```bash
cmake .. -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

### 常见问题举例

clang-tidy 能抓到哪些问题：

```c
// bugprone-integer-division：整型除法结果赋给浮点，精度丢失
float ratio = count / total;  // 警告：count 和 total 都是 int

// clang-analyzer-core.uninitialized.Assign：未初始化就使用
int result;
if (condition) result = 42;
return result;  // 警告：condition 为假时 result 未初始化

// bugprone-sizeof-expression：sizeof 用法可能不是预期的
memset(buf, 0, sizeof(buf) / sizeof(buf[0]));  // 可能想要 sizeof(buf)
```

这类问题编译器不会报错，测试也不一定能覆盖到，静态分析是最低成本的发现方式。

---

## 四、单元测试

单元测试是针对代码中最小可测试单元（通常是一个函数或模块）的自动化测试。每个测试用例给定输入，验证输出是否符合预期。测试是代码的一部分，和源码一起提交、一起维护，每次改动后重新跑一遍，确认没有破坏已有行为。

和"手动跑一下看看对不对"相比，单元测试的优势是可重复、可自动化——一百个测试用例一秒跑完，哪个失败立刻告诉你。重构代码时尤其有价值：有测试兜底，改完跑一遍，绿了就放心。

嵌入式项目写单元测试的最大障碍不是框架选型，而是硬件依赖。业务逻辑里直接调用了 `HAL_UART_Transmit()`、`gpio_write()`，在 host 上根本没有这些函数，测试跑不起来。

解决办法是**把硬件依赖变成接口**，业务逻辑只依赖接口，测试时传入 mock 实现，真实运行时传入实际驱动。这就是依赖注入在嵌入式里的用法，在设计模式那篇里也提到过。

### 接口抽象驱动层

以 UART 为例，定义一个接口结构体：

```c
// include/project/uart.h
typedef struct {
    int  (*write)(const uint8_t *data, size_t len);
    int  (*read)(uint8_t *buf, size_t len, uint32_t timeout_ms);
} UartOps;
```

真实驱动实现：

```c
// drivers/uart/uart_stm32.c
static int stm32_uart_write(const uint8_t *data, size_t len) {
    return HAL_UART_Transmit(&huart1, data, len, 100) == HAL_OK ? 0 : -1;
}

static int stm32_uart_read(uint8_t *buf, size_t len, uint32_t timeout_ms) {
    return HAL_UART_Receive(&huart1, buf, len, timeout_ms) == HAL_OK ? 0 : -1;
}

const UartOps uart_stm32 = {
    .write = stm32_uart_write,
    .read  = stm32_uart_read,
};
```

业务层只持有 `UartOps` 指针，不知道背后是什么实现：

```c
// src/comm.c
int comm_send_packet(const UartOps *uart, const Packet *pkt) {
    uint8_t buf[256];
    size_t len = packet_serialize(pkt, buf, sizeof(buf));
    return uart->write(buf, len);
}
```

### 用 Unity 写测试

Unity 是专为嵌入式设计的 C 测试框架，单文件，没有动态内存分配，可以在 host 和裸机上运行。

测试时用 mock 实现替代真实驱动：

```c
// test/test_comm.c
#include "unity.h"
#include "project/comm.h"

// Mock：记录写入的数据
static uint8_t mock_buf[256];
static size_t  mock_len = 0;

static int mock_uart_write(const uint8_t *data, size_t len) {
    memcpy(mock_buf, data, len);
    mock_len = len;
    return 0;
}

static const UartOps mock_uart = {
    .write = mock_uart_write,
    .read  = NULL,
};

void setUp(void) {
    memset(mock_buf, 0, sizeof(mock_buf));
    mock_len = 0;
}

void tearDown(void) {}

void test_comm_send_packet_correct_length(void) {
    Packet pkt = { .id = 1, .payload = {0xAA, 0xBB}, .len = 2 };
    int ret = comm_send_packet(&mock_uart, &pkt);

    TEST_ASSERT_EQUAL(0, ret);
    TEST_ASSERT_EQUAL(6, mock_len);  // header(2) + len(2) + payload(2)
}

void test_comm_send_packet_correct_header(void) {
    Packet pkt = { .id = 1, .payload = {0xAA}, .len = 1 };
    comm_send_packet(&mock_uart, &pkt);

    TEST_ASSERT_EQUAL_HEX8(0xAA, mock_buf[0]);  // 包头字节
    TEST_ASSERT_EQUAL_HEX8(0x55, mock_buf[1]);
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_comm_send_packet_correct_length);
    RUN_TEST(test_comm_send_packet_correct_header);
    return UNITY_END();
}
```

在 CMake 里添加测试目标（只在 host 编译时构建，交叉编译时跳过）：

```cmake
# test/CMakeLists.txt
if(NOT CMAKE_CROSSCOMPILING)
    add_executable(test_comm
        test_comm.c
        ${PROJECT_SOURCE_DIR}/third_party/unity/unity.c
    )
    target_link_libraries(test_comm app_core)
    target_include_directories(test_comm PRIVATE
        ${PROJECT_SOURCE_DIR}/third_party/unity
    )

    enable_testing()
    add_test(NAME comm_tests COMMAND test_comm)
endif()
```

本机编译后运行：

```bash
cmake .. && make
ctest --output-on-failure
```

输出：

```
test_comm.c:28:test_comm_send_packet_correct_length:PASS
test_comm.c:35:test_comm_send_packet_correct_header:PASS

2 Tests 0 Failures 0 Ignored
OK
```

核心思路：**硬件驱动不测，业务逻辑全测**。驱动层的正确性靠硬件在环测试（HIL）或手工验证，单元测试覆盖的是协议解析、状态机、数据处理这些纯逻辑部分。

---

## 五、CI

CI（持续集成，Continuous Integration）是一种开发实践：每次代码提交后，自动触发构建和测试，快速反馈这次改动有没有引入问题。"持续"的意思是每次 push 都跑，而不是攒一堆再统一验证。

没有 CI 的团队通常是这样的：各自在本地开发，合并时才发现编译不过，或者某个人的改动悄悄破坏了别人的功能，排查要花大量时间。CI 把这个反馈循环从"合并时"缩短到"提交后几分钟内"。

### 为什么需要 CI

本地能编译不代表别人能编译，本地测试过不代表合并后还能过。CI（持续集成）的作用是每次 push 都自动跑一遍编译和测试，问题在合入前暴露，而不是等到集成阶段。

对嵌入式项目来说，CI 至少要做两件事：**host 编译 + 单元测试**，以及**交叉编译验证**。前者保证业务逻辑没问题，后者保证目标平台能编过。

### GitHub Actions 配置

在项目根目录建 `.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y cmake ninja-build clang-format clang-tidy

      - name: Check format
        run: |
          cmake -B build -G Ninja -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
          cmake --build build --target format-check

      - name: Build (host)
        run: |
          cmake -B build-host -G Ninja -DCMAKE_BUILD_TYPE=Debug
          cmake --build build-host

      - name: Run tests
        run: |
          cd build-host
          ctest --output-on-failure

  cross-compile:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Install ARM toolchain
        run: |
          sudo apt-get update
          sudo apt-get install -y cmake ninja-build gcc-arm-linux-gnueabihf

      - name: Cross compile
        run: |
          cmake -B build-arm -G Ninja \
            -DCMAKE_TOOLCHAIN_FILE=cmake/arm-linux.cmake \
            -DCMAKE_BUILD_TYPE=Release
          cmake --build build-arm
```

两个 job 并行跑：`build-and-test` 跑 host 编译、格式检查、单元测试；`cross-compile` 跑 ARM 交叉编译，验证目标平台能编过。

### 保护主分支

CI 配置完之后，在 GitHub 仓库设置里开启分支保护：Settings → Branches → Add rule，勾选 "Require status checks to pass before merging"，选中 CI 的两个 job。

这样 PR 不通过 CI 就无法合入，从流程上保证主分支始终是干净可编译的状态。

---

这几块加在一起，项目的基本工程质量就有了保障：目录结构清晰、构建系统可扩展、格式和静态分析自动检查、业务逻辑有测试覆盖、每次提交自动验证。不需要一次性全部到位，按优先级来——先上 CMake 和 clang-format，再补测试，最后接 CI。
