---
title: "FreeRTOS 学习笔记（一）：任务管理"
date: 2025-08-10T22:00:00+08:00
categories: ["FreeRTOS"]
tags: ["FreeRTOS", "RTOS", "嵌入式"]
cover: /images/FreeRTOS_note/image.png
top_img: false
---

一个 FreeRTOS 任务就是一个永不返回的 C 函数：

```c
void MyTask(void *pvParameters) {
    while (1) {
        // 干点什么
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
```

任务在五种状态之间切换：

```
                 xTaskCreate()
                      │
                      ▼
    ┌──────────── 就绪态 ◄────────────────┐
    │                │                    │
    │          调度器选中               时间片到/被抢占
    │                │                    │
    │                ▼                    │
    │         运行态 ──────────────────────┘
    │                │
    │   vTaskDelay() │  │ 等队列/信号量
    │                │
    │                ▼
    │         阻塞态 ─── 事件到达/超时
    │                │
    └────────────────┘
                      
              vTaskSuspend()
                     │
                     ▼
               挂起态 (只能被别的任务 vTaskResume() 拉回来)
```

调度器决定下一个跑谁。FreeRTOS 默认**抢占式 + 时间片轮转**：高优先级就绪立刻抢占，同优先级轮流执行。

以下情况不会发生任务切换：

1. 在临界区里（`taskENTER_CRITICAL()` ... `taskEXIT_CRITICAL()`）
2. 关了调度器（`vTaskSuspendAll()` ... `xTaskResumeAll()`）
3. 正在 ISR 里（中断退出时才切）

这三个是调 FreeRTOS 时"我的任务为什么没跑"的标准答案。

---

创建任务：

```c
BaseType_t xTaskCreate(
    TaskFunction_t   pvTaskCode,       // 函数指针
    const char *     pcName,           // 调试用，别太长
    configSTACK_DEPTH_TYPE usStackDepth, // 堆栈，单位是 word 不是 byte
    void *           pvParameters,     // 传参
    UBaseType_t      uxPriority,       // 数字越大越高
    TaskHandle_t *   pxCreatedTask     // 句柄
);
```

删任务：`vTaskDelete(NULL)` 删自己，idle 任务会回收 TCB 和堆栈。

延时有两个函数，坑不少：

```c
void vTaskDelay(TickType_t xTicksToDelay);                    // 相对延时
void vTaskDelayUntil(TickType_t *pxWakeTime, TickType_t inc); // 绝对延时
```

`vTaskDelay(100ms)`：从现在起等 100ms。但任务自己跑了 3ms 才调它，实际间隔就是 103ms。

`vTaskDelayUntil(&lastWake, 100ms)`：以上次醒来为基准加 100ms，亏掉的时间下次补回来。

需要固定频率执行的场合（10ms 读一次传感器、20ms 刷一次屏），必须用 `vTaskDelayUntil`。

```c
// ❌ 实际周期 = 10ms + 执行时间
while (1) {
    ReadSensor();
    vTaskDelay(pdMS_TO_TICKS(10));
}

// ✅ 严格 10ms
TickType_t last = xTaskGetTickCount();
while (1) {
    ReadSensor();
    vTaskDelayUntil(&last, pdMS_TO_TICKS(10));
}
```

其他 API：

```c
vTaskPrioritySet(handle, prio);      // 改优先级
uxTaskPriorityGet(handle);           // 查优先级
vTaskSuspend(handle);                // 挂起
vTaskResume(handle);                 // 恢复（任务上下文）
xTaskResumeFromISR(handle);          // 恢复（ISR 中）
xTaskGetTickCount();                 // 启动以来的 tick 数
uxTaskGetNumberOfTasks();            // 当前任务数
pcTaskGetName(handle);               // 任务名（调试用）
vTaskSuspendAll();                   // 关调度（ISR 仍可触发）
xTaskResumeAll();                    // 开调度
```

---

下面是一个跑得通的三任务例子：

```c
#include "FreeRTOS.h"
#include "task.h"

// LED 闪烁，500ms 一次
void vLEDTask(void *pv) {
    while (1) {
        HAL_GPIO_TogglePin(LED_GPIO_Port, LED_Pin);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

// 串口打印，严格 1 秒周期
void vLogTask(void *pv) {
    TickType_t last = xTaskGetTickCount();
    while (1) {
        printf("Uptime: %lu ms\r\n",
               xTaskGetTickCount() * portTICK_PERIOD_MS);
        vTaskDelayUntil(&last, pdMS_TO_TICKS(1000));
    }
}

// 按键扫描，20ms 轮询
void vButtonTask(void *pv) {
    while (1) {
        if (HAL_GPIO_ReadPin(BUTTON_GPIO_Port, BUTTON_Pin)) {
            printf("Button pressed!\r\n");
            vTaskDelay(pdMS_TO_TICKS(200)); // 去抖
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

int main(void) {
    HAL_Init();
    SystemClock_Config();

    xTaskCreate(vLEDTask,    "LED",    128, NULL, 1, NULL);
    xTaskCreate(vLogTask,    "Logger", 256, NULL, 2, NULL);
    xTaskCreate(vButtonTask, "Button", 128, NULL, 3, NULL);

    vTaskStartScheduler();
    while (1);
}
```

优先级 Button(3) > Logger(2) > LED(1)，按键总能最快响应。

如果用 CMSIS-RTOS v2（STM32CubeMX 默认生成），底层也是 `xTaskCreate`，区别是堆栈单位变成 byte：

```c
const osThreadAttr_t attr = {
    .name       = "LED",
    .stack_size = 512,  // 注意：byte，不是 word
    .priority   = osPriorityNormal,
};
osThreadNew(vLEDTask, NULL, &attr);
```

---

**堆栈怎么估算？**

新手的噩梦。没公式，土办法：

1. 先设大（比如 512 words）
2. 跑几个小时后看 `uxTaskGetStackHighWaterMark(handle)`，返回剩余堆栈
3. 实际用量 ≈ 配置值 - high water mark，留 1.5x 余量

```c
// 空闲钩子里每 60 秒打印一次堆栈使用
void vApplicationIdleHook(void) {
    static uint32_t count = 0;
    if (++count % 60000 == 0) {
        printf("LED stack free: %lu words\r\n",
               uxTaskGetStackHighWaterMark(xLEDHandle));
    }
}
```

另外 `FreeRTOSConfig.h` 里打开溢出检测：

```c
#define configCHECK_FOR_STACK_OVERFLOW 2
```

方案 2 在创建任务时用 `0xA5` 填满堆栈，溢出时 canary 被破坏，下次切换时检测到。开销极小。

---

**空闲任务能干什么？**

`vTaskStartScheduler()` 自动建了个优先级 0 的空闲任务。它只做一件事：回收被删除任务的 TCB 和堆栈。

空闲钩子能帮上忙的：

```c
void vApplicationIdleHook(void) {
    // ✅ 低功耗：配合 configUSE_TICKLESS_IDLE 进入 sleep
    // ✅ 喂狗：前提是保证所有任务阻塞后 idle 能及时喂
    // ✅ 调试：打印堆栈使用量
    // ✅ 性能：递增一个计数器，vTaskGetRunTimeStats() 可以看到 idle 跑了多少时间
}
```

**不能干的事：** 调任何会阻塞的 API——`vTaskDelay`、`xQueueReceive`、`xSemaphoreTake`——idle 是系统最后的救命稻草，它被阻塞系统就挂了。

---

**不要靠调优先级修 bug。**

刚上手容易犯的错：任务不够及时 → 优先级 +1 → 另一个任务又不够了 → 再 +1 → 所有任务都在高优先级打架，跟没上 RTOS 一样。

任务没按时跑，先排查：是不是临界区太长关了中断？是不是有高优先级任务一直在跑没 block？是不是 configTICK_RATE_HZ 太低分辨率不够？优先级是最后的调整手段。

---

**configTICK_RATE_HZ 怎么选？**

```
1000Hz → 1ms tick   → 实时性好，功耗高（每秒 1000 次 SysTick 中断）
100Hz  → 10ms tick  → 功耗低，vTaskDelay 最小分辨率 10ms
```

电池供电的设备降到 100Hz 省电很明显。大多数应用不需要 1ms 精度。选好之后别忘了 `pdMS_TO_TICKS()` 会自动换算，代码不用改。

---
