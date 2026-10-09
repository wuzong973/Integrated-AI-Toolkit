-- AlterTable
ALTER TABLE `tool` ADD COLUMN `visible` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `tool_category` ADD COLUMN `visible` BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX `tool_visible_category_id_sort_idx` ON `tool`(`visible`, `category_id`, `sort`);
